docker build . -t bitcoin-dev

docker run -it -v ${PWD}/bitcoin.conf:/root/.bitcoin/bitcoin.conf -v ${PWD}/scripts:/root/scripts -p 8080:8080 -p 8089:8089 bitcoin-dev

