const express = require("express");
const mysql = require("mysql2");
const fs = require("fs");
const path = require("path");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

// DB 연결 설정
require("dotenv").config();

const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// 정적 파일 제공
app.use(express.static(path.join(__dirname, "public")));

const logStream = fs.createWriteStream("db_status.log", { flags: "a" });

function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}\n`;
  logStream.write(logMessage);
  io.emit("db-log", logMessage);
}

async function checkDatabaseStatus() {
  let status = {
    activeConnections: 0,
    totalProcesses: 0,
    slowQueries: 0,
    maxConnections: 0,
    status: "connected",
  };

  try {
    // 활성 연결 수 확인
    const [threads] = await connection
      .promise()
      .query('SHOW STATUS LIKE "Threads_connected"');
    status.activeConnections = parseInt(threads[0].Value);
    logToFile(`활성 연결 수: ${status.activeConnections}`);

    // 프로세스 리스트 확인
    const [processes] = await connection.promise().query("SHOW PROCESSLIST");
    status.totalProcesses = processes.length;
    logToFile(`총 프로세스 수: ${status.totalProcesses}`);

    const longRunningQueries = processes.filter((p) => p.Time > 5);
    status.slowQueries = longRunningQueries.length;
    if (longRunningQueries.length > 0) {
      logToFile(`장시간 실행 쿼리 수: ${longRunningQueries.length}`);
      longRunningQueries.forEach((q) => {
        logToFile(
          `- ID: ${q.Id}, Time: ${q.Time}s, State: ${q.State}, Info: ${q.Info}`
        );
      });
    }

    // 최대 연결 수 확인
    const [maxConn] = await connection
      .promise()
      .query('SHOW VARIABLES LIKE "max_connections"');
    status.maxConnections = parseInt(maxConn[0].Value);
    logToFile(`최대 연결 수 설정: ${status.maxConnections}`);

    io.emit("db-status", status);
  } catch (err) {
    logToFile(`상태 확인 중 에러: ${err.message}`);
    status.status = "disconnected";
    io.emit("db-status", status);
  }
}

connection.connect((err) => {
  if (err) {
    logToFile(`초기 연결 실패: ${err.message}`);
    return;
  }
  logToFile("데이터베이스 연결 성공");

  setInterval(checkDatabaseStatus, 60000); // 1분마다 상태 체크
  checkDatabaseStatus(); // 초기 상태 체크
});

connection.on("error", (err) => {
  logToFile(`데이터베이스 에러 발생: ${err.message}`);
  if (err.code === "PROTOCOL_CONNECTION_LOST") {
    logToFile("데이터베이스 연결이 끊어짐");
    io.emit("db-status", { status: "disconnected" });
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

// Socket.IO 연결 처리
io.on("connection", (socket) => {
  console.log("클라이언트 연결됨");
  checkDatabaseStatus(); // 새 클라이언트 연결시 현재 상태 전송

  socket.on("disconnect", () => {
    console.log("클라이언트 연결 해제");
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행중입니다`);
});
