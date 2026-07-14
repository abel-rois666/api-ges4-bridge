const Firebird = require('node-firebird');
require('dotenv').config();
const dbOptions = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT, 10),
    database: process.env.DB_PATH,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    lowercase_keys: false,
    role: null,
    pageSize: 4096
};
Firebird.attach(dbOptions, function(err, db) {
    if (err) throw err;
    const q = 'SELECT FIRST 10 G.CODIGOGRUPO, G.INICIAL, G.FINAL, G.PERIODO, G.NIVEL, (SELECT FIRST 1 ID_PLAN FROM PROFESORES_GRUPOS PG WHERE PG.CODIGOGRUPO = G.CODIGOGRUPO AND PG.INICIAL = G.INICIAL AND PG.FINAL = G.FINAL AND PG.PERIODO = G.PERIODO) AS ID_PLAN FROM GRUPOS G WHERE (SELECT FIRST 1 ID_PLAN FROM PROFESORES_GRUPOS PG WHERE PG.CODIGOGRUPO = G.CODIGOGRUPO AND PG.INICIAL = G.INICIAL AND PG.FINAL = G.FINAL AND PG.PERIODO = G.PERIODO) IS NOT NULL';
    db.query(q, function(err, result) {
        if (err) throw err;
        console.log(result);
        db.detach();
    });
});
