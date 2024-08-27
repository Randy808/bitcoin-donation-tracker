const zmq = require("zeromq");
let { WebSocketServer } = require("ws");
const express = require("express");
const app = express();
const http = require("http");
const bitcoinjs = require("bitcoinjs-lib");
const { createRpcClient } = require("./rpc_client");

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

async function run(ws) {
  const sock = new zmq.Subscriber();

  sock.connect(`tcp://127.0.0.1:${ZEROMQ_PORT}`);
  sock.subscribe("rawtx");
  console.log(`Subscriber connected to port ${ZEROMQ_PORT}`);

  for await (const [topic, msg] of sock) {
    console.log(
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
          await refreshBalance(ws);
        }
      } catch (e) {
        console.log(e.message);
      }
    }
  }
}

async function refreshBalance(ws) {
  try {
    await client.request("loadwallet", { filename: WALLET_NAME });
  } catch (e) {
    if (!e.message.includes("is already loaded.")) {
      console.log(e.message);
    }
  }

  let confirmed = await client.request("getbalance");
  let unconfirmed = await client.request("getunconfirmedbalance");

  ws.send(
    JSON.stringify({
      confirmed,
      unconfirmed,
    })
  );
}

const wss = new WebSocketServer({ server });

wss.on("connection", function connection(ws) {
  ws.on("error", console.error);

  ws.on("message", function message(data) {
    console.log("received: %s", data);
  });

  refreshBalance(ws);
  run(ws);
});

async function createWalletIfNotExists(rpcClient, walletName) {
  let newWallet = true;

  try {
    await rpcClient.request("createwallet", { wallet_name: walletName });
  } catch (e) {
    if (!e.message.includes("Database already exists")) {
      throw e;
    }
    console.log(`Wallet '${walletName}' already exists.`);
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
    console.log(`Wallet '${walletName}' already loaded.`);
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
    console.log("Generating blocks and funding default wallet...");
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
  console.log(donationAddress);
  initializationFinished = true;
};

function startServer() {
  if (initializationFinished) {
    console.log("Starting server");
    return server.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  }

  console.log();
  console.log("Wallet initialization incomplete.");
  console.log("Waiting another second.");
  console.log();

  setTimeout(startServer, 1_000);
}

initializeWallet();
startServer();
