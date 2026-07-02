require('dotenv').config();
const Firebird = require('node-firebird');

const dbOptions = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3050,
    database: process.env.DB_PATH,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    lowercase_keys: false,
    role: null,
    pageSize: 4096
};

Firebird.attach(dbOptions, (err, db) => {
    if (err) {
        console.error("Connection Error:", err);
        process.exit(1);
    }
    const q = "SELECT INICIAL, FINAL, PERIODO, DESCRIPCION, CODIGO_CORTO, DENOM_PERIODO FROM CICLOS WHERE INICIAL >= 2023 ORDER BY INICIAL, PERIODO";
    db.query(q, (err, res) => {
        if (err) console.error("Query Error:", err);
        else console.log(JSON.stringify(res, null, 2));
        db.detach();
        process.exit(0);
    });
});
