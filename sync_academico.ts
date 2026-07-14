import { createClient } from '@supabase/supabase-js';
import Firebird from 'node-firebird';

// --- CONFIGURACIÓN ---
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const fbOptions: Firebird.Options = {
    host: process.env.FB_HOST,
    port: Number(process.env.FB_PORT) || 3050,
    database: process.env.FB_DATABASE,
    user: process.env.FB_USER,
    password: process.env.FB_PASSWORD,
};

const PLAN_CARRERA_DEFAULT_ID = 9; // Regla de Negocio
const BATCH_SIZE = 500;

// --- TIPOS ---
type Dictionary = Record<string, string>;

// --- UTILIDADES DE MEMORIA (PRECARGA DE DICCIONARIOS) ---
async function loadDictionary(tableName: string, keyColumn: string, valueColumn: string = 'id'): Promise<Dictionary> {
    const dict: Dictionary = {};
    let offset = 0;
    const limit = 1000;
    let hasMore = true;

    console.log(`[Diccionario] Cargando tabla: ${tableName}...`);
    while (hasMore) {
        const { data, error } = await supabase
            .from(tableName)
            .select(`${keyColumn}, ${valueColumn}`)
            .range(offset, offset + limit - 1);

        if (error) throw new Error(`Error cargando diccionario ${tableName}: ${error.message}`);
        
        if (data && data.length > 0) {
            data.forEach(item => {
                const key = String(item[keyColumn]).trim();
                dict[key] = String(item[valueColumn]);
            });
            offset += limit;
        } else {
            hasMore = false;
        }
    }
    return dict;
}

// Carga especial para ciclos (requiere múltiples campos para resolución)
async function loadCiclosDictionary(): Promise<any[]> {
    console.log(`[Diccionario] Cargando ciclos_escolares...`);
    const { data, error } = await supabase
        .from('ciclos_escolares')
        .select('id, inicial, final, periodo, descripcion, modalidad');
    
    if (error) throw new Error(`Error cargando ciclos: ${error.message}`);
    return data || [];
}

// --- LÓGICA DE NEGOCIO: RESOLUCIÓN DE CICLOS ---
function resolveCicloId(row: any, ciclos: any[]): string | null {
    let inicial = Number(row.INICIAL);
    let final = Number(row.FINAL);
    let periodo = Number(row.PERIODO);
    const descripcionLegada = String(row.NOMBRE_CICLO_LEGADO || '').trim().toLowerCase();

    // Correcciones específicas para inconsistencias de la base de datos legado
    if (inicial === 2005 && periodo === 1) {
        periodo = 2; // 2005-2 tiene periodo 1 incorrecto
    }
    if (inicial === 2013 && periodo === 2) {
        periodo = 1; // 2013-1 tiene periodo 2 incorrecto
    }

    // CASO A: Periodo 0 (Comodín) - Búsqueda por descripción de texto
    if (periodo === 0) {
        const match = ciclos.find(c => String(c.descripcion).trim().toLowerCase() === descripcionLegada);
        if (match) return match.id;
    }

    // Filtro base por año y periodo
    const matches = ciclos.filter(c => c.inicial === inicial && c.final === final && c.periodo === periodo);

    if (matches.length === 0) return null;

    // CASO C: Estándar (Match único)
    if (matches.length === 1) return matches[0].id;

    // CASO B: Ciclos duplicados (2020+) - Desempate por modalidad (Semestral vs Cuatrimestral)
    // Se asume inferencia basada en la estructura del plan o grupo. (Se usa Semestral por defecto o según prefijo de grupo)
    // Esto se puede enriquecer si la tabla GRUPOS del legado indica el tipo.
    const isSemestral = true; // Lógica custom para detectar modalidad del grupo
    const tieBreak = matches.find(c => isSemestral ? c.modalidad === 'Semestral' : c.modalidad === 'Cuatrimestral');
    
    return tieBreak ? tieBreak.id : matches[0].id;
}

// --- UTILIDAD FIREBIRD A PROMESAS ---
const queryFirebird = (db: Firebird.Database, query: string, params: any[] = []): Promise<any[]> => {
    return new Promise((resolve, reject) => {
        db.query(query, params, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
};

// --- MÓDULOS DE EXTRACCIÓN Y CARGA (ETL) ---

// 1. MIGRAR DOCENTES
async function migrateDocentes(db: Firebird.Database) {
    console.log('\n--- Migrando Docentes ---');
    const rows = await queryFirebird(db, 'SELECT TRIM(CLAVEPROFESOR) AS CLAVE, TRIM(NOMBRE) AS NOMBRE, TRIM(APELLIDOS) AS APELLIDOS, TRIM(RFC) AS RFC, TRIM(CURP) AS CURP, ACTIVO FROM PROFESORES');
    
    const payload = rows.map(row => ({
        clave_legado: row.CLAVE,
        nombre_completo: `${row.NOMBRE} ${row.APELLIDOS}`.trim(),
        rfc: row.RFC,
        curp: row.CURP,
        estatus: (row.ACTIVO === 'S' || row.ACTIVO === 1) ? 'activo' : 'inactivo' // Regla: Solo metadatos, no deletes
    }));

    // Batch Upsert
    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const batch = payload.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('docentes').upsert(batch, { onConflict: 'clave_legado' });
        if (error) console.error(`Error en batch docentes:`, error.message);
    }
    console.log(`Docentes procesados: ${payload.length}`);
}

// 2. MIGRAR GRUPOS
async function migrateGrupos(db: Firebird.Database, ciclos: any[], planesMap: Dictionary) {
    console.log('\n--- Migrando Grupos ---');
    const query = `
        SELECT TRIM(CLAVEGRUPO) AS GRUPO, INICIAL, FINAL, PERIODO, TRIM(TURNO) AS TURNO, GRADO, TRIM(ID_PLAN) AS ID_PLAN
        FROM GRUPOS
    `;
    const rows = await queryFirebird(db, query);
    
    const payload = [];
    for (const row of rows) {
        const ciclo_id = resolveCicloId(row, ciclos);
        
        // Uso de Diccionario y Regla de Negocio (ID de carrera 9 para cruces genéricos)
        const plan_id = planesMap[row.ID_PLAN] || planesMap[PLAN_CARRERA_DEFAULT_ID] || null;

        if (!ciclo_id || !plan_id) {
            console.warn(`[Grupos] Skiping grupo ${row.GRUPO}: falta ciclo_id o plan_id.`);
            continue;
        }

        payload.push({
            codigo_grupo: row.GRUPO,
            ciclo_id,
            plan_id,
            grado: Number(row.GRADO) || null,
            turno: row.TURNO,
            estatus: 'activo'
        });
    }

    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const batch = payload.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('grupos').upsert(batch, { onConflict: 'codigo_grupo,ciclo_id' }); // Asegurar que (codigo_grupo, ciclo_id) sea unique en bd
        if (error) console.error(`Error en batch grupos:`, error.message);
    }
    console.log(`Grupos procesados: ${payload.length}`);
}

// 3. MIGRAR RELACIÓN DOCENTE-GRUPO-ASIGNATURA
async function migrateDocentesGrupos(db: Firebird.Database, docentesMap: Dictionary, gruposMap: Dictionary, asignaturasMap: Dictionary) {
    console.log('\n--- Migrando Relaciones Docentes-Grupos ---');
    const rows = await queryFirebird(db, 'SELECT TRIM(CLAVEPROFESOR) AS DOCENTE, TRIM(CLAVEGRUPO) AS GRUPO, TRIM(CLAVEASIGNATURA) AS ASIGNATURA FROM PROFESORES_GRUPOS');
    
    const payload = [];
    for (const row of rows) {
        const docente_id = docentesMap[row.DOCENTE];
        const grupo_id = gruposMap[row.GRUPO];
        const asignatura_id = asignaturasMap[row.ASIGNATURA];

        if (!docente_id || !grupo_id || !asignatura_id) {
            console.warn(`[Doc-Grp] Relación huérfana ignorada: Doc:${row.DOCENTE}, Grp:${row.GRUPO}, Asg:${row.ASIGNATURA}`);
            continue;
        }

        payload.push({ docente_id, grupo_id, asignatura_id });
    }

    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const batch = payload.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('docentes_grupos_asignaturas').upsert(batch, { onConflict: 'grupo_id,asignatura_id,docente_id', ignoreDuplicates: true });
        if (error) console.error(`Error en batch rel docentes:`, error.message);
    }
    console.log(`Relaciones Docentes-Grupos procesadas: ${payload.length}`);
}

// 4. MIGRAR RELACIÓN ALUMNOS-GRUPOS
async function migrateAlumnosGrupos(db: Firebird.Database, alumnosMap: Dictionary, gruposMap: Dictionary, asignaturasMap: Dictionary) {
    console.log('\n--- Migrando Relaciones Alumnos-Grupos ---');
    // Asume tabla ALUMNOS_GRUPOS en legado
    const rows = await queryFirebird(db, 'SELECT TRIM(MATRICULA) AS MATRICULA, TRIM(CLAVEGRUPO) AS GRUPO, TRIM(CLAVEASIGNATURA) AS ASIGNATURA FROM ALUMNOS_GRUPOS');
    
    const payload = [];
    for (const row of rows) {
        const alumno_id = alumnosMap[row.MATRICULA];
        const grupo_id = gruposMap[row.GRUPO];
        const asignatura_id = row.ASIGNATURA ? asignaturasMap[row.ASIGNATURA] : null;

        if (!alumno_id || !grupo_id) {
            console.warn(`[Alu-Grp] Relación huérfana ignorada: Mat:${row.MATRICULA}, Grp:${row.GRUPO}`);
            continue;
        }

        payload.push({ alumno_id, grupo_id, asignatura_id });
    }

    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
        const batch = payload.slice(i, i + BATCH_SIZE);
        const { error } = await supabase.from('alumnos_grupos').upsert(batch, { onConflict: 'alumno_id,grupo_id,asignatura_id', ignoreDuplicates: true });
        if (error) console.error(`Error en batch rel alumnos:`, error.message);
    }
    console.log(`Relaciones Alumnos-Grupos procesadas: ${payload.length}`);
}

// --- ORQUESTADOR PRINCIPAL ---
export async function runAcademicoMigration() {
    console.log('=== INICIANDO ETL ACADÉMICO ===');
    
    Firebird.attach(fbOptions, async (err, db) => {
        if (err) {
            console.error('Error conectando a Firebird:', err);
            return;
        }

        try {
            // Fase 1: Precarga de Memoria (Evitar N+1 queries)
            const ciclos = await loadCiclosDictionary();
            const planesMap = await loadDictionary('planes_estudio', 'clave_legado');
            
            // Fase 2: Inserciones Base
            await migrateDocentes(db);
            
            // Recargar diccionarios actualizados
            const docentesMap = await loadDictionary('docentes', 'clave_legado');
            
            await migrateGrupos(db, ciclos, planesMap);
            
            // Recargar diccionarios necesarios para tablas intermedias
            const gruposMap = await loadDictionary('grupos', 'codigo_grupo');
            const asignaturasMap = await loadDictionary('asignaturas', 'clave_legado');
            const alumnosMap = await loadDictionary('alumnos', 'matricula'); // asumiendo matricula como clave legado
            
            // Fase 3: Tablas Intermedias Transaccionales
            await migrateDocentesGrupos(db, docentesMap, gruposMap, asignaturasMap);
            await migrateAlumnosGrupos(db, alumnosMap, gruposMap, asignaturasMap);
            
            console.log('=== ETL ACADÉMICO FINALIZADO CORRECTAMENTE ===');

        } catch (error) {
            console.error('Error crítico en ejecución ETL:', error);
        } finally {
            db.detach();
        }
    });
}

// Si se ejecuta directamente desde Node
if (require.main === module) {
    runAcademicoMigration();
}
