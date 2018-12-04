// tslint:disable:no-console
import { Connection, ConnectionOptions, createConnection, Repository } from 'typeorm';

import { CryptoCompareOHLCVSource } from '../data_sources/ohlcv_external/crypto_compare';
import { OHLCVExternal } from '../entities';
import * as ormConfig from '../ormconfig';
import { OHLCVMetadata, parseRecords } from '../parsers/ohlcv_external/crypto_compare';
import { handleError } from '../utils';
import { fetchOHLCVTradingPairsAsync, TradingPair } from '../utils/get_ohlcv_trading_pairs';

const SOURCE_NAME = 'CryptoCompare';
// tslint:disable:custom-no-magic-numbers
const TWO_HOURS_AGO = new Date().getTime() - 2 * 60 * 60 * 1000;
const ONE_HOUR_AGO = new Date().getTime() - 60 * 60 * 1000;

const MAX_CONCURRENT_REQUESTS = parseInt(process.env.CRYPTOCOMPARE_MAX_CONCURRENT_REQUESTS || '18', 10);
const EARLIEST_BACKFILL_DATE = process.env.OHLCV_EARLIEST_BACKFILL_DATE || '2018-09-01'; // the time when BTC/USD info starts appearing on Crypto Compare
const EARLIEST_BACKFILL_TIME = new Date(EARLIEST_BACKFILL_DATE).getTime();

let connection: Connection;

(async () => {
    connection = await createConnection(ormConfig as ConnectionOptions);
    const repository = connection.getRepository(OHLCVExternal);
    const source = new CryptoCompareOHLCVSource(MAX_CONCURRENT_REQUESTS);

    const tradingPairs = await fetchOHLCVTradingPairsAsync(connection, SOURCE_NAME, EARLIEST_BACKFILL_TIME);
    console.log(`Starting ${tradingPairs.length} job(s) to scrape Crypto Compare for OHLCV records...`);

    const fetchAndSavePromises = tradingPairs.map(async pair => {
        const pairs = source.generateBackfillIntervals(pair);
        return fetchAndSaveAsync(source, repository, pairs);
    });
    await Promise.all(fetchAndSavePromises);
    console.log(`Finished scraping OHLCV records from Crypto Compare, exiting...`);
    process.exit(0);
})().catch(handleError);

async function fetchAndSaveAsync(
    source: CryptoCompareOHLCVSource,
    repository: Repository<OHLCVExternal>,
    pairs: TradingPair[],
): Promise<void> {
    const sortAscTimestamp = (a: TradingPair, b: TradingPair): number => {
        if (a.latest < b.latest) {
            return -1;
        } else if (a.latest > b.latest) {
            return 1;
        } else {
            return 0;
        }
    };
    pairs.sort(sortAscTimestamp);

    let i = 0;
    let shouldContinue = true;
    while (i < pairs.length && shouldContinue) {
        const pair = pairs[i];
        if (pair.latest > TWO_HOURS_AGO) {
            break;
        }
        const rawRecords = await source.getHourlyOHLCVAsync(pair);
        const records = rawRecords.filter(rec => rec.time < ONE_HOUR_AGO); // Crypto Compare can take ~30mins to finalise records
        const metadata: OHLCVMetadata = {
            exchange: source.default_exchange,
            fromSymbol: pair.fromSymbol,
            toSymbol: pair.toSymbol,
            source: SOURCE_NAME,
            observedTimestamp: new Date().getTime(),
            interval: source.intervalBetweenRecords,
        };
        const parsedRecords = parseRecords(records, metadata);
        try {
            await saveRecordsAsync(repository, parsedRecords);
            i++;
        } catch (err) {
            console.log(`Error saving OHLCVRecords, stopping task for ${JSON.stringify(pair)} [${err}]`);
            shouldContinue = false;
        }
    }
    return Promise.resolve();
}

async function saveRecordsAsync(repository: Repository<OHLCVExternal>, records: OHLCVExternal[]): Promise<void> {
    const metadata = [
        records[0].fromSymbol,
        records[0].toSymbol,
        new Date(records[0].startTime),
        new Date(records[records.length - 1].endTime),
    ];

    console.log(`Saving ${records.length} records to ${repository.metadata.name}... ${JSON.stringify(metadata)}`);
    await repository.save(records);
}
