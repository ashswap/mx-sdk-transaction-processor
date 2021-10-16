import axios from "axios";

export class TransactionProcessor {
  private startCurrentNonces: { [ key: number ]: number } = {};
  private startDate: Date = new Date();
  private shardIds: number[] = [];
  private options: TransactionProcessorOptions = new TransactionProcessorOptions();
  private readonly lastProcessedNoncesInternal: { [key: number]: number } = {};
  private isRunning: boolean = false;

  private crossShardDictionary: { [ key: string ]: CrossShardTransaction } = {};

  async start(options: TransactionProcessorOptions) {
    if (this.isRunning) {
      throw new Error('Transaction processor is already running');
    }

    this.isRunning = true;

    let crossShardHashes = Object.keys(this.crossShardDictionary);
    for (let crossShardHash of crossShardHashes) {
      let crossShardItem = this.crossShardDictionary[crossShardHash];
      let elapsedSeconds = (new Date().getTime() - crossShardItem.created.getTime()) / 1000;
      if (elapsedSeconds > 600) {
        this.logMessage(LogTopic.CrossShardSmartContractResult, `Pruning transaction with hash ${crossShardHash} since its elapsed time is ${elapsedSeconds} seconds`);
        delete this.crossShardDictionary[crossShardHash];
      }
    }

    try {
      this.options = options;
      this.startDate = new Date();
      this.shardIds = await this.getShards();
      this.startCurrentNonces = await this.getCurrentNonces();

      let startLastProcessedNonces: { [ key: number ]: number } = {};

      let reachedTip: boolean;

      do {
        reachedTip = true;

        for (let shardId of this.shardIds) {
          let currentNonce = await this.estimateCurrentNonce(shardId);
          let lastProcessedNonce = await this.getLastProcessedNonceOrCurrent(shardId, currentNonce);

          if (lastProcessedNonce === currentNonce) {
            continue;
          }

          // this is to handle the situation where the current nonce is reset
          // (e.g. devnet/testnet reset where the nonces start again from zero)
          if (lastProcessedNonce > currentNonce) {
            lastProcessedNonce = currentNonce;
          }

          if (options.maxLookBehind && currentNonce - lastProcessedNonce > options.maxLookBehind) {
            lastProcessedNonce = currentNonce - options.maxLookBehind;
          }

          if (!startLastProcessedNonces[shardId]) {
            startLastProcessedNonces[shardId] = lastProcessedNonce;
          }

          let nonce = lastProcessedNonce + 1;

          let transactionsResult = await this.getShardTransactions(shardId, nonce);
          if (transactionsResult === undefined) {
            continue;
          }

          let blockHash = transactionsResult.blockHash;
          let transactions = transactionsResult.transactions;

          reachedTip = false;

          let validTransactions = [];

          if (this.options.waitForFinalizedCrossShardSmartContractResults === true) {
            let crossShardTransactions = this.getFinalizedCrossShardScrTransactions(shardId, transactions);

            for (let crossShardTransaction of crossShardTransactions) {
              validTransactions.push(crossShardTransaction);
            }
          }

          for (let transaction of transactions) {
            // we only care about transactions that are finalized in the given shard
            if (transaction.destinationShard !== shardId && !options.includeCrossShardStartedTransactions) {
              continue;
            }

            // we skip transactions that are cross shard and still pending for smart-contract results
            if (this.crossShardDictionary[transaction.hash]) {
              continue;
            }

            validTransactions.push(transaction);
          }

          if (validTransactions.length > 0 || options.notifyEmptyBlocks === true) {
            this.logMessage(LogTopic.CrossShardSmartContractResult, `crossShardTransactionsCounterDictionary items: ${Object.keys(this.crossShardDictionary).length}`);

            let statistics = new TransactionStatistics();

            statistics.secondsElapsed = (new Date().getTime() - this.startDate.getTime()) / 1000;
            statistics.processedNonces = lastProcessedNonce - startLastProcessedNonces[shardId];
            statistics.noncesPerSecond = statistics.processedNonces / statistics.secondsElapsed;
            statistics.noncesLeft = currentNonce - lastProcessedNonce;
            statistics.secondsLeft = statistics.noncesLeft / statistics.noncesPerSecond * 1.1;

            await this.onTransactionsReceived(shardId, nonce, validTransactions, statistics, blockHash);
          }

          this.setLastProcessedNonce(shardId, nonce);
        }
      } while (reachedTip === false);
    } finally {
      this.isRunning = false;
    }
  }

  private getFinalizedCrossShardScrTransactions(shardId: number, transactions: ShardTransaction[]): ShardTransaction[] {
    let crossShardTransactions: ShardTransaction[] = [];

    // pass 1: we add pending transactions in the dictionary from current shard to another one
    for (let transaction of transactions) {
      if (transaction.originalTransactionHash && transaction.sourceShard === shardId && transaction.destinationShard !== shardId) {
        let crossShardItem = this.crossShardDictionary[transaction.originalTransactionHash];
        if (!crossShardItem) {
          this.logMessage(LogTopic.CrossShardSmartContractResult, `Creating dictionary for original tx hash ${transaction.originalTransactionHash}`);
          let originalTransaction = transactions.find(x => x.hash === transaction.originalTransactionHash);
          if (originalTransaction) {
            crossShardItem = new CrossShardTransaction(originalTransaction);
            this.crossShardDictionary[transaction.originalTransactionHash] = crossShardItem;
          } else {
            this.logMessage(LogTopic.CrossShardSmartContractResult, `Could not identify transaction with hash ${transaction.originalTransactionHash} in transaction list`);
            continue;
          }
        }

        // if '@ok', ignore
        if (transaction.data) {
          let data = this.base64Decode(transaction.data);
          if (data === '@6f6b') {
            this.logMessage(LogTopic.CrossShardSmartContractResult, `Not incrementing counter for cross-shard SCR, original tx hash ${transaction.originalTransactionHash}, tx hash ${transaction.hash} since the data is @ok (${data})`);
            continue;
          }
        }

        crossShardItem.counter++;
        this.logMessage(LogTopic.CrossShardSmartContractResult, `Detected new cross-shard SCR for original tx hash ${transaction.originalTransactionHash}, tx hash ${transaction.hash}, counter = ${crossShardItem.counter}`);

        this.crossShardDictionary[transaction.originalTransactionHash] = crossShardItem;
      }
    }

    // pass 2: we delete pending transactions in the dictionary from another shard to current shard
    for (let transaction of transactions) {
      if (transaction.originalTransactionHash && transaction.sourceShard !== shardId && transaction.destinationShard === shardId) {
        let crossShardItem = this.crossShardDictionary[transaction.originalTransactionHash];
        if (!crossShardItem) {
          this.logMessage(LogTopic.CrossShardSmartContractResult, `No counter available for cross-shard SCR, original tx hash ${transaction.originalTransactionHash}, tx hash ${transaction.hash}`);
          continue;
        }

        // if '@ok', ignore
        if (transaction.data) {
          let data = this.base64Decode(transaction.data);
          if (data === '@6f6b') {
            this.logMessage(LogTopic.CrossShardSmartContractResult, `Not decrementing counter for cross-shard SCR, original tx hash ${transaction.originalTransactionHash}, tx hash ${transaction.hash} since the data is @ok (${data})`);
            continue;
          }
        }

        crossShardItem.counter--;
        this.logMessage(LogTopic.CrossShardSmartContractResult, `Finalized cross-shard SCR for original tx hash ${transaction.originalTransactionHash}, tx hash ${transaction.hash}, counter = ${crossShardItem.counter}`);

        this.crossShardDictionary[transaction.originalTransactionHash] = crossShardItem;
      }
    }

    // step 3. If the counter reached zero, we take the value out
    let crossShardDictionaryHashes = Object.keys(this.crossShardDictionary);
    for (let transactionHash of crossShardDictionaryHashes) {
      let crossShardItem = this.crossShardDictionary[transactionHash];
      if (crossShardItem.counter === 0) {
        this.logMessage(LogTopic.CrossShardSmartContractResult, `Completed cross-shard transaction for original tx hash ${transactionHash}`);
        // we only add it to the cross shard transactions if it isn't already in the list of completed transactions
        if (!transactions.some(transaction => transaction.hash === transactionHash)) {
          crossShardTransactions.push(crossShardItem.transaction);
        }

        delete this.crossShardDictionary[transactionHash];
      }
    }

    return crossShardTransactions;
  }

  private base64Decode(str: string): string {
    return Buffer.from(str, 'base64').toString('binary');
  }

  private selectMany<TIN, TOUT>(array: TIN[], predicate: Function): TOUT[] {
    let result = [];
  
    for (let item of array) {
        result.push(...predicate(item));
    }
  
    return result;
  };

  private async getShardTransactions(shardId: number, nonce: number): Promise<{ blockHash: string, transactions: ShardTransaction[] } | undefined> {
    let result = await this.gatewayGet(`block/${shardId}/by-nonce/${nonce}?withTxs=true`);

    if (!result || !result.block) {
      return undefined;
    }

    if (result.block.miniBlocks === undefined) {
      return { blockHash: result.block.hash, transactions: [] };
    }

    let transactions: ShardTransaction[] = this.selectMany(result.block.miniBlocks, (x: any) => x.transactions)
      .map((item: any) => {
        let transaction = new ShardTransaction();
        transaction.data = item.data;
        transaction.sender = item.sender;
        transaction.receiver = item.receiver;
        transaction.sourceShard = item.sourceShard;
        transaction.destinationShard = item.destinationShard;
        transaction.hash = item.hash;
        transaction.nonce = item.nonce;
        transaction.status = item.status;
        transaction.value = item.value;
        transaction.originalTransactionHash = item.originalTransactionHash;
        transaction.gasPrice = item.gasPrice;
        transaction.gasLimit = item.gasLimit;

        return transaction;
      });

    return { blockHash: result.block.hash, transactions };
  }

  private async getShards(): Promise<number[]> {
    let networkConfig = await this.gatewayGet('network/config');
    let shardCount = networkConfig.config.erd_num_shards_without_meta;

    let result = [];
    for (let i = 0; i < shardCount; i++) {
      result.push(i);
    }

    result.push(4294967295);
    return result;
  }

  private async getCurrentNonce(shardId: number): Promise<number> {
    let shardInfo = await this.gatewayGet(`network/status/${shardId}`);
    return shardInfo.status.erd_nonce;
  }

  private async gatewayGet(path: string): Promise<any> {
    let gatewayUrl = this.options.gatewayUrl ?? 'https://gateway.elrond.com';
    let fullUrl = `${gatewayUrl}/${path}`;

    try {
      let result = await axios.get(fullUrl);
      return result.data.data;
    } catch (error) {
      // console.error(`Error when getting from gateway url ${fullUrl}`, error);
    }
  }

  private async getCurrentNonces(): Promise<{ [ key: number ]: number }> {
    let currentNonces = await Promise.all(
      this.shardIds.map(shardId => this.getCurrentNonce(shardId))
    );

    let result: { [ key: number ]: number } = {};
    for (let [index, shardId] of this.shardIds.entries()) {
      result[shardId] = currentNonces[index];
    }

    return result;
  }

  private async estimateCurrentNonce(shardId: number): Promise<number> {
    let startCurrentNonce = this.startCurrentNonces[shardId];

    let secondsElapsedSinceStart = (new Date().getTime() - this.startDate.getTime()) / 1000;
    let roundsElapsedSinceStart = Math.floor(secondsElapsedSinceStart / 6);

    return startCurrentNonce + roundsElapsedSinceStart;
  }

  private async getLastProcessedNonceOrCurrent(shardId: number, currentNonce: number): Promise<number> {
    let lastProcessedNonce = await this.getLastProcessedNonce(shardId, currentNonce);
    if (lastProcessedNonce === null || lastProcessedNonce === undefined) {
      lastProcessedNonce = currentNonce - 1;
      await this.setLastProcessedNonce(shardId, lastProcessedNonce);
    }

    return lastProcessedNonce;
  }

  private async getLastProcessedNonce(shardId: number, currentNonce: number): Promise<number | undefined> {
    let getLastProcessedNonceFunc = this.options.getLastProcessedNonce;
    if (!getLastProcessedNonceFunc) {
      return this.lastProcessedNoncesInternal[shardId];
    }

    return await getLastProcessedNonceFunc(shardId, currentNonce);
  }

  private async setLastProcessedNonce(shardId: number, nonce: number) {
    let setLastProcessedNonceFunc = this.options.setLastProcessedNonce;
    if (!setLastProcessedNonceFunc) {
      this.lastProcessedNoncesInternal[shardId] = nonce;
      return;
    }

    await setLastProcessedNonceFunc(shardId, nonce);
  }
  
  private async onTransactionsReceived(shardId: number, nonce: number, transactions: ShardTransaction[], statistics: TransactionStatistics, blockHash: string) {
    let onTransactionsReceivedFunc = this.options.onTransactionsReceived;
    if (onTransactionsReceivedFunc) {
      await onTransactionsReceivedFunc(shardId, nonce, transactions, statistics, blockHash);
    }
  }

  private logMessage(topic: LogTopic, message: string) {
    let onMessageLogged = this.options.onMessageLogged;
    if (onMessageLogged) {
      onMessageLogged(topic, message);
    }
  }
}

export enum LogTopic {
  CrossShardSmartContractResult = 'CrossShardSmartContractResult'
}

export class ShardTransaction {
  value: string = '';
  data?: string;
  hash: string = '';
  sender: string = '';
  receiver: string = '';
  status: string = '';
  sourceShard: number = 0;
  destinationShard: number = 0;
  nonce: number = 0;
  previousTransactionHash?: string;
  originalTransactionHash?: string;
  gasPrice?: number;
  gasLimit?: number;

  private dataDecoded: string | undefined;
  private getDataDecoded(): string | undefined {
    if (!this.dataDecoded) {
      if (this.data) {
        this.dataDecoded = base64Decode(this.data);
      }
    }

    return this.dataDecoded;
  }

  private dataFunctionName: string | undefined;
  public getDataFunctionName(): string | undefined {
    if (!this.dataFunctionName) {
      let decoded = this.getDataDecoded();
      if (decoded) {
        this.dataFunctionName = decoded.split('@')[0];
      }
    }

    return this.dataFunctionName;
  }

  private dataArgs: string[] | undefined;
  public getDataArgs(): string[] | undefined {
    if (!this.dataArgs) {
      let decoded = this.getDataDecoded();
      if (decoded) {
        this.dataArgs = decoded.split('@').splice(1);
      }
    }

    return this.dataArgs;
  }
}

export class TransactionProcessorOptions {
  gatewayUrl?: string;
  maxLookBehind?: number;
  waitForFinalizedCrossShardSmartContractResults?: boolean;
  notifyEmptyBlocks?: boolean;
  includeCrossShardStartedTransactions?: boolean;
  onTransactionsReceived?: (shardId: number, nonce: number, transactions: ShardTransaction[], statistics: TransactionStatistics, blockHash: string) => Promise<void>;
  getLastProcessedNonce?: (shardId: number, currentNonce: number) => Promise<number | undefined>;
  setLastProcessedNonce?: (shardId: number, nonce: number) => Promise<void>;
  onMessageLogged?: (topic: LogTopic, message: string) => void;
}

export class TransactionStatistics {
  secondsElapsed: number = 0;
  processedNonces: number = 0;
  noncesPerSecond: number = 0;
  noncesLeft: number = 0;
  secondsLeft: number = 0;
}

export class CrossShardTransaction { 
  transaction: ShardTransaction;
  counter: number = 0;
  created: Date = new Date();

  constructor(transaction: ShardTransaction) {
    this.transaction = transaction;
  }
}

function base64Decode(str: string): string {
  return Buffer.from(str, 'base64').toString('binary');
}
