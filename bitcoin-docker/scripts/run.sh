cd /app/bitcoin-27.1/bin
./bitcoin-cli createwallet ""
./bitcoin-cli -generate 101

./bitcoin-cli createwallet "donations"
./bitcoin-cli -rpcwallet=donations getnewaddress
