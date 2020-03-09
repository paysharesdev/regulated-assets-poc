const fetch = require("node-fetch");
const StellarSdk = require("stellar-sdk");
const { Account } = require("./models");

const server = new StellarSdk.Server("https://horizon-testnet.stellar.org");
const issuer = StellarSdk.Keypair.fromSecret(process.env.ISSUER_SECRET);

module.exports = async function(req, res, next) {
  console.log(req.query.tx);
  const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(
    req.query.tx,
    "base64"
  );
  const tx = new StellarSdk.Transaction(envelope, StellarSdk.Networks.TESTNET);
  let totalAmount = 0;
  let assetsToParticipantMap = {};
  let participants = [];
  console.log("Checking operations in proposed transaction");
  tx.operations.forEach(operation => {
    console.log("  Type: " + operation.type);
    console.log("  Source: " + (operation.source || tx.source));
    console.log("  Destination: " + operation.destination);
    console.log("  Asset: " + operation.asset.getCode());
    console.log("  Amount: " + operation.amount);
    participants.push(operation.destination);
    participants.push(operation.source || tx.source);
    if (operation.type === "payment") {
      const code = operation.asset.getCode();
      assetsToParticipantMap[code] = assetsToParticipantMap[code] || new Set();
      totalAmount += parseFloat(operation.amount);
      assetsToParticipantMap[code].add(operation.source || tx.source);
      assetsToParticipantMap[code].add(operation.destination);
    }
  });
  console.log("Total Amount: " + totalAmount);
  console.log("<<< Consulting Rules Engine API >>>");
  await new Promise(res => setTimeout(res, 1300));
  if (totalAmount > 50) {
    console.log("Rejecting, amount over 50 REG limit");
    res.send({
      status: "rejected",
      error: "Amount over 50 REG limit"
    });
    return;
  }

  for (var i = 0; i < participants.length; i++) {
    const participant = participants[i];
    const dbAccount = await Account.findOne({
      where: {
        stellarAccount: participant
      }
    });
    if (dbAccount.status !== "active") {
      res.send({
        status: "rejected",
        error: `Account ${participant} has had token access revoked`
      });
      return;
    }
  }

  const [sourceAccount, feeStats] = await Promise.all([
    server.loadAccount(tx.source),
    server.feeStats()
  ]);
  console.log("Building revised sandwiched transaction");
  const sandwichTxBuilder = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: feeStats.fee_charged.p90,
    networkPassphrase: StellarSdk.Networks.TESTNET
  });

  const setParticipantAuthorizations = allow => {
    Object.keys(assetsToParticipantMap).forEach(asset => {
      const participants = assetsToParticipantMap[asset];
      participants.forEach(participantAddress => {
        console.log(
          `  ${
            allow ? "Allowing" : "Revoking"
          } asset ${asset} for participant ${participantAddress}`
        );
        sandwichTxBuilder.addOperation(
          StellarSdk.Operation.allowTrust({
            trustor: participantAddress,
            assetCode: asset,
            authorize: allow,
            source: issuer.publicKey()
          })
        );
      });
    });
  };

  setParticipantAuthorizations(true);
  console.log("  Adding operations from original transaction ");
  envelope
    .tx()
    .operations()
    .forEach(op => sandwichTxBuilder.addOperation(op));
  setParticipantAuthorizations(false);
  // 5 minute for demo purposes so it doesn't timeout while we talk about it
  sandwichTxBuilder.setTimeout(300);
  const revisedTx = sandwichTxBuilder.build();
  revisedTx.sign(issuer);
  console.log("Approved, sending revised transaction back to wallet");
  res.send({
    status: "revised",
    tx: revisedTx
      .toEnvelope()
      .toXDR()
      .toString("base64")
  });
};
