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

/**
 * SANITIZADOR DE CALIFICACIONES DEL LEGADO
 * El sistema GES 4 inicializa todas las calificaciones en 0 aunque la materia no haya sido cursada.
 * Esta función aplica las siguientes reglas para convertir esos 0s artificiales a null:
 *
 * Regla 1: Si TODOS los valores (p1, p2, p3, final) son 0 o null -> Todo se convierte a null.
 *          Significa que la materia nunca fue tocada (pura inicialización del sistema).
 *
 * Regla 2: Si la calificación final es 0 pero al menos un parcial tiene valor real
 *          (>0 o -555 NP) -> El final se convierte a null. La materia está en curso.
 *
 * Regla 3: Si la calificación final tiene un valor real (≥5 o -555) -> Se respeta todo.
 *          Es una evaluación completa.
 *
 * Nota: En el sistema educativo mexicano, una calificación real de 0 no existe.
 *       El mínimo regulatorio es 5 o NP (-555).
 */
const sanitizarCalificaciones = (p1, p2, p3, promedio, final) => {
    const esCeroONull = (v) => v === null || v === undefined || v === 0;
    const esValorReal = (v) => v !== null && v !== undefined && v !== 0; // incluye -555 (NP)

    const todosVacios = esCeroONull(p1) && esCeroONull(p2) && esCeroONull(p3) && esCeroONull(final);

    // Regla 1: Todo vacío -> Todo null
    if (todosVacios) {
        return { p1: null, p2: null, p3: null, promedio: null, final: null, estatus: 'SIN_EVALUAR' };
    }

    const tieneParcialesReales = esValorReal(p1) || esValorReal(p2) || esValorReal(p3);
    const finalEsValorReal = esValorReal(final);

    // Regla 2: Final en 0 pero hay parciales -> La materia está en curso
    if (!finalEsValorReal && tieneParcialesReales) {
        return {
            p1: esCeroONull(p1) ? null : p1,
            p2: esCeroONull(p2) ? null : p2,
            p3: esCeroONull(p3) ? null : p3,
            promedio: esCeroONull(promedio) ? null : promedio,
            final: null,
            estatus: 'EN_CURSO'
        };
    }

    // Regla 3: Final real -> Evaluación completa, determinar si aprobó o reprobó
    const pLimpio = (v) => esCeroONull(v) ? null : v;
    let estatus;
    if (final === -555) {
        estatus = 'REPROBADA'; // NP
    } else if (final >= 6) {
        estatus = 'APROBADA';
    } else {
        // final entre 0.1 y 5.9, o exactamente 5, o cero con parciales todos vacíos (borde)
        // Verificar si es reprobada real: final <= 5 y hay evidencia de que fue capturado
        const tresParcialesCapturados = esValorReal(p1) && esValorReal(p2) && esValorReal(p3);
        const finalEsCeroConParciales = final === 0 && tresParcialesCapturados;
        estatus = (final > 0 && final < 6) || final === 5 || finalEsCeroConParciales ? 'REPROBADA' : 'PENDIENTE';
    }

    return {
        p1: pLimpio(p1),
        p2: pLimpio(p2),
        p3: pLimpio(p3),
        promedio: pLimpio(promedio),
        final: final,
        estatus
    };
};

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
                
                // 1. Extraer el Año (Priorizando FINAL, e ignorando ceros y nulos)
                let year = null;
                if (row.FINAL && !isNaN(row.FINAL) && row.FINAL > 0) {
                    year = row.FINAL;
                } else if (row.INICIAL && !isNaN(row.INICIAL) && row.INICIAL > 0) {
                    year = row.INICIAL;
                }

                // 2. Extraer el Periodo
                const periodoNum = (row.PERIODO !== null && row.PERIODO !== undefined && row.PERIODO !== '') ? Number(row.PERIODO) : null;

                // 3. Construir ciclo_actual solo si existen fechas reales (evita inventar "2000-1")
                let ciclo_actual = null;
                if (year !== null) {
                    const p = periodoNum !== null ? periodoNum : 1;
                    ciclo_actual = `${year}-${p}`;

                    // Extraer descripción literal si el periodo es el comodín 0
                    if (p === 0 && row.NOMBRE_CICLO_LEGADO) {
                        const descripcionCompleta = cleanStr(row.NOMBRE_CICLO_LEGADO);
                        ciclo_actual = descripcionCompleta.split(' ')[0];
                    }
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

                // 4. REGLA DE NEGOCIO: El ciclo oficial lo dicta estrictamente la evaluación final.
                const isFinalEval = ['E', 'F', 'G', 'H'].includes(idEval);

                if (isFinalEval) {
                    // Si es un final y trae un ciclo válido, se asigna con autoridad total.
                    if (ciclo_actual !== null) {
                        kardexMap[key].ciclo_legado = ciclo_actual;
                    }
                } else if (kardexMap[key].calificacion_final === null) {
                    // Si está en curso (sin final) y un parcial trae ciclo válido, se le asigna temporalmente.
                    if (ciclo_actual !== null) {
                        kardexMap[key].ciclo_legado = ciclo_actual;
                    }
                }
                // Si ciclo_actual es NULL (materia vacía/no cursada), simplemente se ignora y no altera el Kardex.

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

            const payload = Object.values(kardexMap).map(item => {
                const saneado = sanitizarCalificaciones(
                    item.parcial_1,
                    item.parcial_2,
                    item.parcial_3,
                    item.promedio_calculado,
                    item.calificacion_final
                );

                return {
                    clave_plan: item.clave_plan,
                    clave_asignatura: item.clave_asignatura,
                    ciclo_legado: item.ciclo_legado,
                    tipo_evaluacion: item.tipo_evaluacion,
                    parcial_1: saneado.p1,
                    parcial_2: saneado.p2,
                    parcial_3: saneado.p3,
                    promedio_calculado: saneado.promedio,
                    calificacion_final: saneado.final,
                    estatus: saneado.estatus,
                    observaciones: item.observaciones.length > 0 ? item.observaciones.join(' | ') : null
                };
            });

            // Filtrar las que quedaron completamente sin evaluar si se desea (opcional)
            // const payloadFiltrado = payload.filter(p => p.estatus !== 'SIN_EVALUAR');

            return res.json(payload);
        });
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor puente de Firebird (GES 4) corriendo en http://0.0.0.0:${port} y aceptando conexiones externas`);
});
