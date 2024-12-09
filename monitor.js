const mysql = require("mysql2");
const fs = require("fs");

// DB 연결 설정
require("dotenv").config();

const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const logStream = fs.createWriteStream("db_status.log", { flags: "a" });

function logToFile(message) {
  const timestamp = new Date().toISOString();
  logStream.write(`${timestamp} - ${message}\n`);
}

function checkDatabaseStatus() {
  connection.query('SHOW STATUS LIKE "Threads_connected"', (err, results) => {
    if (err) {
      logToFile(`연결 에러: ${err.message}`);
      return;
    }
    logToFile(`활성 연결 수: ${results[0].Value}`);
  });

  connection.query("SHOW PROCESSLIST", (err, processes) => {
    if (err) {
      logToFile(`프로세스 조회 에러: ${err.message}`);
      return;
    }
    logToFile(`총 프로세스 수: ${processes.length}`);

    const longRunningQueries = processes.filter((p) => p.Time > 5);
    if (longRunningQueries.length > 0) {
      logToFile(`장시간 실행 쿼리 수: ${longRunningQueries.length}`);
      longRunningQueries.forEach((q) => {
        logToFile(
          `- ID: ${q.Id}, Time: ${q.Time}s, State: ${q.State}, Info: ${q.Info}`
        );
      });
    }
  });

  connection.query('SHOW VARIABLES LIKE "max_connections"', (err, results) => {
    if (err) {
      logToFile(`max_connections 조회 에러: ${err.message}`);
      return;
    }
    logToFile(`최대 연결 수 설정: ${results[0].Value}`);
  });
}

connection.connect((err) => {
  if (err) {
    logToFile(`초기 연결 실패: ${err.message}`);
    return;
  }
  logToFile("데이터베이스 연결 성공");

  setInterval(checkDatabaseStatus, 60000);
});

connection.on("error", (err) => {
  logToFile(`데이터베이스 에러 발생: ${err.message}`);
  if (err.code === "PROTOCOL_CONNECTION_LOST") {
    logToFile("데이터베이스 연결이 끊어짐");
  }
});

process.on("SIGINT", () => {
  connection.end((err) => {
    if (err) {
      logToFile(`연결 종료 중 에러: ${err.message}`);
    }
    logToFile("데이터베이스 연결 종료");
    process.exit();
  });
});
