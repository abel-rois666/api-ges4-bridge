const express = require('express');
const cors = require('cors');
const Firebird = require('node-firebird');
require('dotenv').config();

const app = express();
// Levantamos Express en el puerto 3001 por defecto si no está definido en .env
const port = process.env.PORT || 3001;

// Habilitar CORS
app.use(cors());
app.use(express.json());

// Configuración de la conexión a Firebird
const dbOptions = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3050,
    database: process.env.DB_PATH,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    lowercase_keys: false, // Mantiene los nombres de las columnas en mayúsculas tal cual la DB
    role: null,
    pageSize: 4096
};

// ==========================================
// FUNCIONES DE AYUDA Y MAPEADO
// ==========================================

// Helper para parsear TIMESTAMP de Firebird a YYYY-MM-DD
const formatFecha = (dateValue) => {
    if (!dateValue) return null;
    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return null; // por si acaso no es un timestamp válido
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

// Función de ayuda para asegurar que si viene un string nulo o indefinido devuelva null o la cadena
// También se encarga de quitar espacios en blanco de sobra si la DB usa CHAR en lugar de VARCHAR
const cleanStr = (str) => typeof str === 'string' ? str.trim() : str;

const MAPA_NIVELES = {
    'LP': 'PEDAGOGÍA',
    'LM': 'MERCADOTECNIA',
    'LD': 'DERECHO',
    'LCP': 'CONTADURÍA PÚBLICA',
    'LA': 'ADMINISTRACIÓN',
    'LSP': 'PSICOLOGÍA',
    'ESPDU': 'DOCENCIA UNIVERSITARIA',
    'ESPAN': 'ADMINISTRACIÓN DE NEGOCIOS',
    'ESPDP': 'DERECHO PENAL'
};

// Mapeo y traducción al JSON de respuesta de un registro de Alumno
const mapAlumno = (alumno) => {
    // Traducción de sexo
    // Si devuelve 'F', manda 'M' (Mujer). Si devuelve 'M', manda 'H' (Hombre).
    let sexoTraducido = alumno.SEXO;
    if (alumno.SEXO === 'F') {
        sexoTraducido = 'M';
    } else if (alumno.SEXO === 'M') {
        sexoTraducido = 'H';
    }

    const nivelCrudo = cleanStr(alumno.NIVEL) || '';
    const nivelUpper = nivelCrudo.toUpperCase();
    const licenciaturaTraducida = MAPA_NIVELES[nivelUpper]
        || nivelCrudo.replace(/LICENCIATURA EN /i, '').trim().toUpperCase();

    return {
        licenciatura: licenciaturaTraducida,
        nombre_completo: `${cleanStr(alumno.PATERNO) || ''} ${cleanStr(alumno.MATERNO) || ''} ${cleanStr(alumno.NOMBRE) || ''}`.trim(),
        matricula: cleanStr(alumno.MATRICULA),
        curp: cleanStr(alumno.CURP),
        fecha_nacimiento: formatFecha(alumno.FECHANACIMIENTO),
        sexo: sexoTraducido,
        domicilio: cleanStr(alumno.DOMICILIO),
        cp: cleanStr(alumno.CP),
        municipio: cleanStr(alumno.MUNICIPIO),
        estado: alumno.ESTADO, // Tal cual viene de Firebird
        telefono: cleanStr(alumno.TELEFONO),
        celular: cleanStr(alumno.CELULAR),
        email: cleanStr(alumno.EMAIL),
        estado_nacimiento: cleanStr(alumno.ESTADO_NACIMIENTO),
        nacionalidad: cleanStr(alumno.NACIONALIDAD),
        escuela_procedencia: cleanStr(alumno.ESCUELA_PROCEDENCIA),
        estado_escolaridad: cleanStr(alumno.ESTADO_ESCOLARIDAD)
    };
};

// ==========================================
// ENDPOINTS
// ==========================================

// 1. Endpoint de Diagnóstico (GET /api/test-db)
app.get('/api/test-db', (req, res) => {
    Firebird.attach(dbOptions, (err, db) => {
        if (err) {
            console.error('Error al conectar a Firebird en test-db:', err);
            return res.status(500).json({ error: 'Error de conexión a la base de datos', details: err.message });
        }

        // Si conectó correctamente, nos desconectamos
        db.detach();
        return res.json({ status: "success", message: "Conexión a Firebird exitosa" });
    });
});

// 2. Endpoint de Búsqueda por Nombre (GET /api/legacy/alumnos/buscar)
app.get('/api/legacy/alumnos/buscar', (req, res) => {
    const queryParam = req.query.q;

    if (!queryParam) {
        return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q"' });
    }

    // En Firebird, "CONTAINING" hace una búsqueda insensible a mayúsculas/minúsculas
    // sin necesidad de comodines % ni de la función UPPER() que causa errores de charset.
    const words = queryParam.trim().split(/\s+/);

    let query = `
        SELECT NOMBRE, PATERNO, MATERNO, MATRICULA, CURP, FECHANACIMIENTO, SEXO, 
               DOMICILIO, CP, MUNICIPIO, ESTADO, TELEFONO, CELULAR, EMAIL, 
               ESTADO_NACIMIENTO, NACIONALIDAD, ESCUELA_PROCEDENCIA, 
               ESTADO_ESCOLARIDAD, NIVEL 
        FROM ALUMNOS 
        WHERE 1=1
    `;
    const params = [];

    words.forEach(word => {
        query += ` AND (COALESCE(NOMBRE, '') || ' ' || COALESCE(PATERNO, '') || ' ' || COALESCE(MATERNO, '')) CONTAINING ?`;
        params.push(word);
    });

    Firebird.attach(dbOptions, (err, db) => {
        if (err) {
            console.error('Error al conectar a Firebird en búsqueda:', err);
            return res.status(500).json({ error: 'Error de conexión a la base de datos' });
        }

        db.query(query, params, (err, result) => {
            // Siempre liberamos la conexión después de usarla
            db.detach();

            if (err) {
                console.error('Error al ejecutar la consulta de búsqueda:', err);
                return res.status(500).json({ error: 'Error al consultar la base de datos' });
            }

            if (!result || result.length === 0) {
                // Devolvemos un arreglo vacío si no hay coincidencias
                return res.json([]);
            }

            // Mapeamos todos los resultados usando la función de ayuda
            const alumnos = result.map(mapAlumno);
            return res.json(alumnos);
        });
    });
});

// 3. Endpoint de Extracción por Matrícula (GET /api/legacy/alumno/:matricula)
app.get('/api/legacy/alumno/:matricula', (req, res) => {
    const { matricula } = req.params;

    const query = `
        SELECT NOMBRE, PATERNO, MATERNO, MATRICULA, CURP, FECHANACIMIENTO, SEXO, 
               DOMICILIO, CP, MUNICIPIO, ESTADO, TELEFONO, CELULAR, EMAIL, 
               ESTADO_NACIMIENTO, NACIONALIDAD, ESCUELA_PROCEDENCIA, 
               ESTADO_ESCOLARIDAD, NIVEL 
        FROM ALUMNOS 
        WHERE MATRICULA = ?
    `;

    // Conectamos a la base de datos
    Firebird.attach(dbOptions, (err, db) => {
        if (err) {
            console.error('Error al conectar a Firebird en matricula:', err);
            // Si hay error de conexión, status 500
            return res.status(500).json({ error: 'Error de conexión a la base de datos' });
        }

        // Ejecutamos la consulta
        db.query(query, [matricula], (err, result) => {
            // Siempre liberamos la conexión después de usarla
            db.detach();

            if (err) {
                console.error('Error al ejecutar la consulta por matricula:', err);
                return res.status(500).json({ error: 'Error al consultar la base de datos' });
            }

            // Si no encuentra al alumno, devuelve status 404
            if (!result || result.length === 0) {
                return res.status(404).json({ error: 'Alumno no encontrado' });
            }

            const alumno = mapAlumno(result[0]);
            return res.json(alumno);
        });
    });
});

// 4. Endpoint de Extracción de Estructura Académica (GET /api/legacy/academico/planes)
app.get('/api/legacy/academico/planes', (req, res) => {
    const query = `
        SELECT 
            TRIM(N.NIVEL) AS NIVEL_CLAVE, TRIM(N.DESCRIPCION) AS NOMBRE_CARRERA,
            TRIM(P.ID_PLAN) AS ID_PLAN, TRIM(P.NOMBRE_PLAN) AS NOMBRE_PLAN,
            TRIM(E.ID_ETAPA) AS ID_ETAPA, TRIM(E.DESCRIPCION) AS NOMBRE_ETAPA,
            TRIM(D.CLAVEASIGNATURA) AS CLAVEASIGNATURA, TRIM(D.NOMBREASIGNATURA) AS NOMBREASIGNATURA, D.CREDITOS
        FROM CFGNIVELES N
        JOIN CFGPLANES_MST P ON N.NIVEL = P.NIVEL AND N.ID_ESCUELA = P.ID_ESCUELA
        JOIN CFGPLANES_ETAPAS E ON P.ID_PLAN = E.ID_PLAN AND E.ID_ESCUELA = P.ID_ESCUELA
        JOIN CFGPLANES_DET D ON E.ID_PLAN = D.ID_PLAN AND E.ID_ETAPA = D.ID_ETAPA AND D.ID_ESCUELA = E.ID_ESCUELA
        WHERE P.ACTIVO = 'A' AND D.ID_TIPOEVAL = 'A'
        ORDER BY N.NIVEL, P.ID_PLAN, E.ID_ETAPA, D.CLAVEASIGNATURA
    `;

    Firebird.attach(dbOptions, (err, db) => {
        if (err) {
            console.error('Error al conectar a Firebird en planes académicos:', err);
            return res.status(500).json({ error: 'Error de conexión a la base de datos', details: err.message });
        }

        db.query(query, (err, result) => {
            // Siempre liberamos la conexión después de usarla
            db.detach();

            if (err) {
                console.error('Error al ejecutar la consulta de planes académicos:', err);
                return res.status(500).json({ error: 'Error al consultar la base de datos' });
            }

            if (!result || result.length === 0) {
                return res.json([]);
            }

            // Transformar el resultado plano a formato jerárquico
            const nivelesMap = new Map();

            result.forEach(row => {
                const nivelClave = row.NIVEL_CLAVE;
                const nivelDescripcion = row.NOMBRE_CARRERA;
                const idPlan = row.ID_PLAN;
                const nombrePlan = row.NOMBRE_PLAN;
                const idEtapa = row.ID_ETAPA;
                const nombreEtapa = row.NOMBRE_ETAPA;
                const claveAsignatura = row.CLAVEASIGNATURA;
                const nombreAsignatura = row.NOMBREASIGNATURA;
                const creditos = row.CREDITOS;

                // 1. Obtener o crear el nivel
                if (!nivelesMap.has(nivelClave)) {
                    nivelesMap.set(nivelClave, {
                        nivel_clave: nivelClave,
                        nivel_descripcion: nivelDescripcion,
                        planes: []
                    });
                }
                const nivelNode = nivelesMap.get(nivelClave);

                // 2. Obtener o crear el plan dentro de ese nivel
                let planNode = nivelNode.planes.find(p => p.id_plan === idPlan);
                if (!planNode) {
                    planNode = {
                        id_plan: idPlan,
                        nombre_plan: nombrePlan,
                        etapas: []
                    };
                    nivelNode.planes.push(planNode);
                }

                // 3. Obtener o crear la etapa dentro de ese plan
                let etapaNode = planNode.etapas.find(e => e.id_etapa === idEtapa);
                if (!etapaNode) {
                    etapaNode = {
                        id_etapa: idEtapa,
                        descripcion: nombreEtapa,
                        asignaturas: []
                    };
                    planNode.etapas.push(etapaNode);
                }

                // 4. Agregar la asignatura dentro de la etapa si viene información
                if (claveAsignatura) {
                    etapaNode.asignaturas.push({
                        clave: claveAsignatura,
                        nombre: nombreAsignatura,
                        creditos: creditos ? Number(creditos) : 0
                    });
                }
            });

            const responseJson = Array.from(nivelesMap.values());
            return res.json(responseJson);
        });
    });
});

// Endpoint de Extracción de Kardex (Refactorizado con JOIN y Unificación)
app.get('/api/legacy/kardex/:matricula', (req, res) => {
    const { matricula } = req.params;

    // 1 VIAJE DE RED: Hacemos el cruce de MATRICULA a NUMEROALUMNO directamente en SQL
    const query = `
        SELECT 
            TRIM(K.ID_PLAN) AS CLAVE_PLAN,
            TRIM(K.CLAVEASIGNATURA) AS CLAVE_ASIGNATURA,
            TRIM(K.ID_EVAL) AS ID_EVAL,
            K.CALIFICACION_1 AS CALIFICACION,
            K.FECHA AS FECHA_EVALUACION,
            K.INICIAL,
            K.FINAL,
            K.PERIODO,
            TRIM(C.DESCRIPCION) AS NOMBRE_CICLO_LEGADO,
            TRIM(O.OBSERVACIONES) AS OBSERVACION
        FROM ALUMNOS A
        JOIN ALUMNOS_KARDEX K ON A.NUMEROALUMNO = K.NUMEROALUMNO
        LEFT JOIN CICLOS C 
            ON K.INICIAL = C.INICIAL 
            AND K.FINAL = C.FINAL 
            AND K.PERIODO = C.PERIODO
        LEFT JOIN ALUMNOS_KARDEX_OBS O 
            ON K.NUMEROALUMNO = O.NUMEROALUMNO 
            AND K.ID_PLAN = O.ID_PLAN 
            AND K.CLAVEASIGNATURA = O.CLAVEASIGNATURA 
            AND K.ID_TIPOEVAL = O.ID_TIPOEVAL
            AND K.ID_EVAL = O.ID_EVAL
        WHERE A.MATRICULA = ?
        ORDER BY K.INICIAL, K.PERIODO, K.CLAVEASIGNATURA, K.ID_EVAL
    `;

    Firebird.attach(dbOptions, (err, db) => {
        if (err) {
            console.error('Error al conectar a Firebird en kardex:', err);
            return res.status(500).json({ error: 'Error de conexión a la base de datos' });
        }

        db.query(query, [matricula], (err, rows) => {
            db.detach();

            if (err) {
                console.error('Error al extraer Kardex:', err);
                return res.status(500).json({ error: 'Error al consultar la base de datos' });
            }

            if (!rows || rows.length === 0) {
                return res.json([]);
            }

            const kardexMap = {};

            rows.forEach(row => {
                const cal = row.CALIFICACION === -999 ? null : Number(row.CALIFICACION);
                const idEval = cleanStr(row.ID_EVAL);
                
                // 1. Año priorizando FINAL (para ciclos desfasados Otoño-Invierno)
                const year = (row.FINAL && !isNaN(row.FINAL) && row.FINAL > 0) 
                    ? row.FINAL 
                    : ((row.INICIAL && !isNaN(row.INICIAL)) ? row.INICIAL : 2000);
                    
                // 2. Respetar el 0 estricto del GES 4
                const periodoNum = (row.PERIODO !== null && row.PERIODO !== undefined) ? row.PERIODO : 1;

                let ciclo_actual = `${year}-${periodoNum}`;

                // 3. Extraer la descripción literal de la tabla CICLOS si el periodo es el comodín 0
                if (periodoNum === 0 && row.NOMBRE_CICLO_LEGADO) {
                    const descripcionCompleta = cleanStr(row.NOMBRE_CICLO_LEGADO);
                    // Dividir por espacios y tomar el primer elemento (ej. "2023-2")
                    ciclo_actual = descripcionCompleta.split(' ')[0];
                }

                const tipoEvalBase = ['F', 'G', 'H'].includes(idEval) ? 'Extraordinario' : 'Ordinario';
                const key = `${cleanStr(row.CLAVE_PLAN)}_${cleanStr(row.CLAVE_ASIGNATURA)}_${tipoEvalBase}`;

                if (!kardexMap[key]) {
                    kardexMap[key] = {
                        clave_plan: cleanStr(row.CLAVE_PLAN),
                        clave_asignatura: cleanStr(row.CLAVE_ASIGNATURA),
                        ciclo_legado: ciclo_actual,
                        tipo_evaluacion: tipoEvalBase,
                        parcial_1: null,
                        parcial_2: null,
                        parcial_3: null,
                        promedio_calculado: null,
                        calificacion_final: null,
                        observaciones: []
                    };
                }

                // 4. Actualizar SIEMPRE el ciclo al más reciente para resolver los recursamientos
                kardexMap[key].ciclo_legado = ciclo_actual;

                const observacion = cleanStr(row.OBSERVACION);
                if (observacion && observacion !== '') {
                    kardexMap[key].observaciones.push(observacion);
                }

                switch(idEval) {
                    case 'A': kardexMap[key].parcial_1 = cal; break;
                    case 'B': kardexMap[key].parcial_2 = cal; break;
                    case 'C': kardexMap[key].parcial_3 = cal; break;
                    case 'D': kardexMap[key].promedio_calculado = cal; break;
                    case 'E': 
                    case 'F': 
                    case 'G': 
                    case 'H': 
                        kardexMap[key].calificacion_final = cal; 
                        break;
                }
            });

            const payload = Object.values(kardexMap).map(item => ({
                ...item,
                observaciones: item.observaciones.length > 0 ? item.observaciones.join(' | ') : null
            }));

            return res.json(payload);
        });
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor puente de Firebird (GES 4) corriendo en http://0.0.0.0:${port} y aceptando conexiones externas`);
});
