const zmq = require("zeromq");
let { WebSocketServer } = require("ws");
const express = require("express");
const app = express();
const http = require("http");
const bitcoinjs = require("bitcoinjs-lib");
const { createRpcClient } = require("./rpc_client");
const winston = require("winston");

let logger = winston.createLogger();

if (process.env.NODE_ENV === "development") {
  logger = winston.createLogger({
    level: "debug",
  });

  logger.add(
    new winston.transports.Console({
      format: winston.format.simple(),
    })
  );
}

const { ZEROMQ_PORT, WALLET_NAME, PORT, NETWORK } = process.env;
let donationAddress = undefined;

const client = createRpcClient(`/wallet/${WALLET_NAME}`);
const UI_DIR = __dirname + "/ui";
app.get("/", (req, res) => {
  res.sendFile(UI_DIR + "/index.html");
});

app.get("/styles.css", (req, res) => {
  res.sendFile(UI_DIR + "/styles.css");
});

app.get("/qrcode.min.js", (req, res) => {
  res.sendFile(UI_DIR + "/qrcode.min.js");
});

app.get("/address", (req, res) => {
  res.status(200).send(donationAddress);
});

server = http.Server(app);

async function run(websockets) {
  const sock = new zmq.Subscriber();

  sock.connect(`tcp://127.0.0.1:${ZEROMQ_PORT}`);
  sock.subscribe("rawtx");
  logger.debug(`Subscriber connected to port ${ZEROMQ_PORT}`);

  for await (const [topic, msg] of sock) {
    logger.debug(
      "received a message related to:",
      topic.toString(),
      "containing message:",
      msg.toString("hex")
    );

    const t = bitcoinjs.Transaction.fromHex(msg.toString("hex"));

    for (let i = 0; i < t.outs.length; i++) {
      try {
        let address = bitcoinjs.address.fromOutputScript(
          t.outs[i].script,
          bitcoinjs.networks.regtest
        );
        if (address == donationAddress) {
          await refreshBalance(websockets);
        }
      } catch (e) {
        logger.debug(e.message);
      }
    }
  }
}

async function refreshBalance(websockets) {
  try {
    await client.request("loadwallet", { filename: WALLET_NAME });
  } catch (e) {
    if (!e.message.includes("is already loaded.")) {
      logger.debug(e.message);
    }
  }

  let confirmed = await client.request("getbalance");
  let unconfirmed = await client.request("getunconfirmedbalance");

  for (let i = 0; i < websockets.length; i++) {
    websockets[i].send(
      JSON.stringify({
        confirmed,
        unconfirmed,
      })
    );
  }
}

const wss = new WebSocketServer({ server });
let websocketConnections = [];

wss.on("connection", function connection(ws) {
  ws.on("error", logger.error);

  ws.on("message", function message(data) {
    logger.debug("received: %s", data);
  });

  websocketConnections.push(ws);
  refreshBalance([ws]);
});

async function createWalletIfNotExists(rpcClient, walletName) {
  let newWallet = true;

  try {
    await rpcClient.request("createwallet", { wallet_name: walletName });
  } catch (e) {
    if (!e.message.includes("Database already exists")) {
      throw e;
    }
    logger.debug(`Wallet '${walletName}' already exists.`);
    newWallet = false;
  }

  try {
    let loadedWallets = await rpcClient.request("listwallets");
    if (!loadedWallets.includes(walletName)) {
      await rpcClient.request("loadwallet", { filename: walletName });
    }
  } catch (e) {
    if (!e.message.includes("is already loaded.")) {
      throw e;
    }
    logger.debug(`Wallet '${walletName}' already loaded.`);
  }

  return newWallet;
}

let initializationFinished = false;
const initializeWallet = async () => {
  const rpcClient = createRpcClient("");
  await createWalletIfNotExists(rpcClient, "");
  const defaultWalletClient = createRpcClient("/wallet/");

  if (NETWORK == "regtest") {
    // Fund the default wallet with block subsidies
    logger.debug("Generating blocks and funding default wallet...");
    let address = await defaultWalletClient.request("getnewaddress");
    await defaultWalletClient.request("generatetoaddress", {
      nblocks: 101,
      address,
    });
  }

  // Create the donation wallet
  await createWalletIfNotExists(defaultWalletClient, WALLET_NAME);
  const donationWalletClient = createRpcClient(`/wallet/${WALLET_NAME}`);
  donationAddress = await donationWalletClient.request("getnewaddress");
  logger.debug(donationAddress);

  if (NETWORK == "regtest") {
    logger.debug("Scheduling test payment...");

    setTimeout(async () => {
      await defaultWalletClient.request("sendtoaddress", {
        address: donationAddress,
        amount: "0.00001000",
      });
    }, 15000);
  }

  initializationFinished = true;
};

function startServer() {
  if (initializationFinished) {
    logger.debug("Starting server");
    return server.listen(PORT, () => {
      logger.debug(`Server started on port ${PORT}`);
    });
  }

  logger.debug();
  logger.debug("Wallet initialization incomplete.");
  logger.debug("Waiting another second.");
  logger.debug();

  setTimeout(startServer, 1_000);
}

run(websocketConnections);
initializeWallet();
startServer();
