const express = require("express");
const mysql = require("mysql2");
const fs = require("fs");
const path = require("path");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

require("dotenv").config();

const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

app.use(express.static(path.join(__dirname, "public")));

const logStream = fs.createWriteStream("db_status.log", { flags: "a" });

let lastStatus = null;

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
    timestamp: new Date().getTime(),
  };

  try {
    // 활성 연결 수 확인
    const [threads] = await connection
      .promise()
      .query('SHOW STATUS LIKE "Threads_connected"');
    status.activeConnections = parseInt(threads[0].Value);

    // 프로세스 리스트 확인
    const [processes] = await connection.promise().query("SHOW PROCESSLIST");
    status.totalProcesses = processes.length;

    const longRunningQueries = processes.filter((p) => p.Time > 5);
    status.slowQueries = longRunningQueries.length;

    // 최대 연결 수 확인
    const [maxConn] = await connection
      .promise()
      .query('SHOW VARIABLES LIKE "max_connections"');
    status.maxConnections = parseInt(maxConn[0].Value);

    // 상태가 변경되었을 때만 로그 기록
    if (
      !lastStatus ||
      lastStatus.activeConnections !== status.activeConnections ||
      lastStatus.totalProcesses !== status.totalProcesses ||
      lastStatus.slowQueries !== status.slowQueries
    ) {
      logToFile(
        `상태 업데이트 - 활성 연결: ${status.activeConnections}, 프로세스: ${status.totalProcesses}, 슬로우 쿼리: ${status.slowQueries}`
      );

      if (status.slowQueries > 0) {
        longRunningQueries.forEach((q) => {
          logToFile(
            `- ID: ${q.Id}, Time: ${q.Time}s, State: ${q.State}, Info: ${q.Info}`
          );
        });
      }
    }

    lastStatus = status;
    io.emit("db-status", status);
  } catch (err) {
    logToFile(`상태 확인 중 에러: ${err.message}`);
    status.status = "disconnected";
    io.emit("db-status", status);
  }
}

// 실시간 모니터링 시작/중지를 위한 변수
let monitoringInterval;

function startMonitoring() {
  checkDatabaseStatus(); // 즉시 첫 체크 실행
  monitoringInterval = setInterval(checkDatabaseStatus, 3000); // 3초마다 체크
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
  }
}

connection.connect((err) => {
  if (err) {
    logToFile(`초기 연결 실패: ${err.message}`);
    return;
  }
  logToFile("데이터베이스 연결 성공");
  startMonitoring();
});

connection.on("error", (err) => {
  logToFile(`데이터베이스 에러 발생: ${err.message}`);
  if (err.code === "PROTOCOL_CONNECTION_LOST") {
    logToFile("데이터베이스 연결이 끊어짐");
    io.emit("db-status", {
      status: "disconnected",
      timestamp: new Date().getTime(),
    });
    stopMonitoring();
  }
});

// Socket.IO 연결 처리
io.on("connection", (socket) => {
  console.log("클라이언트 연결됨");
  if (lastStatus) {
    socket.emit("db-status", lastStatus);
  }

  socket.on("disconnect", () => {
    console.log("클라이언트 연결 해제");
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행중입니다`);
});

// 안전한 종료 처리
async function gracefulShutdown(signal) {
  console.log(`\n${signal} 시그널을 수신했습니다. 서버를 안전하게 종료합니다.`);

  stopMonitoring();

  http.close(() => {
    console.log("HTTP 서버가 종료되었습니다.");
  });

  io.close(() => {
    console.log("Socket.IO 연결이 종료되었습니다.");
  });

  logStream.end(() => {
    console.log("로그 스트림이 종료되었습니다.");
  });

  try {
    await connection.promise().end();
    console.log("데이터베이스 연결이 안전하게 종료되었습니다.");
  } catch (err) {
    console.error("데이터베이스 연결 종료 중 에러:", err);
  }

  process.exit(0);
}

["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal, () => gracefulShutdown(signal));
});
