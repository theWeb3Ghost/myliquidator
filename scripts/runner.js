import fs from "fs";
import fetch from "node-fetch";
import pLimit from "p-limit";
import { ethers } from "ethers";
import "dotenv/config";

/* ============================================================
   CONFIG
============================================================ */

const CHAIN_ID = process.env.CHAIN_ID; //check  morphodocs!!!!
const MORPHO_API = process.env.MORPHO_API; //public availability
const PAGE_SIZE = 100;
const CONCURRENCY = 3;  //reducing rate limits

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const MORPHO = process.env.MORPHO_ADDRESS;
const LIQUIDATOR = process.env.LIQUIDATOR_ADDRESS;

/* ============================================================
   ABIs
============================================================ */

const MORPHO_ABI = [
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function position(bytes32,address) view returns (uint256,uint128,uint128)"
];

const LIQUIDATOR_ABI = JSON.parse(
  fs.readFileSync("../foundry/out/liquidator.json", "utf8")
);

/* ============================================================
   PROVIDER / CONTRACTS
============================================================ */

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const morpho = new ethers.Contract(MORPHO, MORPHO_ABI, provider);
const liquidator = new ethers.Contract(LIQUIDATOR, LIQUIDATOR_ABI, wallet);

const limit = pLimit(CONCURRENCY);

/* ============================================================
   GRAPHQL HELPERS
============================================================ */

async function gql(query, variables = {}) {
  const res = await fetch(MORPHO_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function paginate(fetchPage) {
  let skip = 0;
  let all = [];

  while (true) {
    const items = await fetchPage(PAGE_SIZE, skip);
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  return all;
}

/* ============================================================
   FETCH MARKETS & POSITIONS
============================================================ */

async function fetchMarkets() {
  return paginate(async (first, skip) => {
    const data = await gql(
      `
      query ($first: Int!, $skip: Int!) {
        markets(
          first: $first
          skip: $skip
          where: { chainId_in: ${CHAIN_ID} }
        ) {
          items {
            uniqueKey
            lltv
            loanAsset { symbol }
            collateralAsset { symbol }
          }
        }
      }
      `,
      { first, skip }
    );

    return data.markets.items;
  });
}

async function fetchPositions(marketKey) {
  return paginate(async (first, skip) => {
    const data = await gql(
      `
      query ($first: Int!, $skip: Int!, $marketKey: String!) {
        marketPositions(
          first: $first
          skip: $skip
          where: { marketUniqueKey_in: [$marketKey] }
        ) {
          items {
            user { address }
            state {
              borrowAssetsUsd
              collateralUsd
            }
          }
        }
      }
      `,
      { first, skip, marketKey }
    );

    return data.marketPositions.items;
  });
}

/* ============================================================
   OFF-CHAIN FILTER (APPROXIMATE)
============================================================ */

function isCandidate(borrowUsd, collateralUsd, lltvRaw) {
  if (borrowUsd <= 0 || collateralUsd <= 0) return false;

  const lltv = Number(lltvRaw) / 1e18;
  const maxBorrowUsd = collateralUsd * lltv;

  return borrowUsd > maxBorrowUsd;
}

/* ============================================================
   ON-CHAIN VERIFICATION (TRUTH)
============================================================ */

async function verifyOnChain(marketId, borrower) {
  try {
    const mp = await morpho.idToMarketParams(marketId);

    const marketParams = [
      mp.loanToken,
      mp.collateralToken,
      mp.oracle,
      mp.irm,
      mp.lltv
    ];

    const pos = await morpho.position(marketId, borrower);
    const borrowShares = BigInt(pos.borrowShares);

    if (borrowShares === 0n) return null;

    
    try{
         await liquidator.liquidate.staticCall(
      marketParams,
      borrower,
      borrowShares
    );
    console.log("pass");
    } catch (error){
        console.error("failed:",error.reason||error.message);
    }
    
   const tx = await liquidator.liquidate(
    liqData,borrower ,
    borrowShares,
    {
      gasLimit: 1_500_000
    }
  );

  console.log("tx sent:", tx.hash);
  await tx.wait();
  console.log("liquidation executed");
    
    
    
   

  } catch {
    return null;
  }
  
}

/* ============================================================
   MAIN SCAN
============================================================ */

async function main() {
  console.log(`Scanning Morpho chain ${CHAIN_ID}...`);

  const markets = await fetchMarkets();
  console.log(`Markets found: ${markets.length}`);

  const verified = [];

  for (const market of markets) {
    const positions = await fetchPositions(market.uniqueKey);

    await Promise.all(
      positions.map(pos =>
        limit(async () => {
          const borrowUsd = Number(pos.state.borrowAssetsUsd);
          const collateralUsd = Number(pos.state.collateralUsd);

          if (!isCandidate(borrowUsd, collateralUsd, market.lltv)) return;

          const check = await verifyOnChain(
            market.uniqueKey,
            pos.user.address
          );

          if (!check) return;

          console.log(
            `✅ VERIFIED: ${pos.user.address} in ${market.loanAsset.symbol}/${market.collateralAsset.symbol} and liquidated`
          );

          verified.push({
            chainId: CHAIN_ID,
            market: market.uniqueKey,
            borrower: pos.user.address,
            loanAsset: market.loanAsset.symbol,
            collateralAsset: market.collateralAsset.symbol,
            borrowShares: check.borrowShares.toString()
          });
        })
      )
    );
  }

  fs.writeFileSync(
    "verified_liquidations_chain.json",
    JSON.stringify(verified, null, 2)
  );

  console.log(`Done. Verified liquidations: ${verified.length}`);
}

main().catch(console.error);

//for bot runnning
// setInterval(async () => {
//   try {
//     await main();
//   } catch (err) {
//     console.error("Scan failed:", err);
//   }
// }, 60_000); // run every 60 seconds
