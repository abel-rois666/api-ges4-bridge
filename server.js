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
    port: parseInt(process.env.DB_PORT, 10) || 3050,
    database: process.env.DB_PATH,
    user: process.env.DB_USER || 'SYSDBA',
    password: process.env.DB_PASSWORD || 'masterkey',
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

    return {
        nombre_completo: `${cleanStr(alumno.NOMBRE) || ''} ${cleanStr(alumno.PATERNO) || ''} ${cleanStr(alumno.MATERNO) || ''}`.trim(),
        matricula: cleanStr(alumno.MATRICULA),
        curp: cleanStr(alumno.CURP),
        fecha_nacimiento: formatFecha(alumno.FECHANACIMIENTO),
        sexo: sexoTraducido,
        domicilio: cleanStr(alumno.DOMICILIO),
        cp: cleanStr(alumno.CP),
        municipio: cleanStr(alumno.MUNICIPIO),
        estado: cleanStr(alumno.ESTADO),
        telefono: cleanStr(alumno.TELEFONO),
        celular: cleanStr(alumno.CELULAR),
        email: cleanStr(alumno.EMAIL),
        lugar_nacimiento: cleanStr(alumno.LUGAR_NACIMIENTO),
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
    const searchTerm = queryParam;

    const query = `
        SELECT NOMBRE, PATERNO, MATERNO, MATRICULA, CURP, FECHANACIMIENTO, SEXO, 
               DOMICILIO, CP, MUNICIPIO, ESTADO, TELEFONO, CELULAR, EMAIL, 
               LUGAR_NACIMIENTO, ESTADO_NACIMIENTO, NACIONALIDAD, ESCUELA_PROCEDENCIA, 
               ESTADO_ESCOLARIDAD 
        FROM ALUMNOS 
        WHERE (NOMBRE || ' ' || PATERNO || ' ' || MATERNO) CONTAINING ?
    `;

    Firebird.attach(dbOptions, (err, db) => {
        if (err) {
            console.error('Error al conectar a Firebird en búsqueda:', err);
            return res.status(500).json({ error: 'Error de conexión a la base de datos' });
        }

        db.query(query, [searchTerm], (err, result) => {
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
               LUGAR_NACIMIENTO, ESTADO_NACIMIENTO, NACIONALIDAD, ESCUELA_PROCEDENCIA, 
               ESTADO_ESCOLARIDAD 
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

app.listen(port, '0.0.0.0', () => {
    console.log(`Servidor puente de Firebird (GES 4) corriendo en http://0.0.0.0:${port} y aceptando conexiones externas`);
});
