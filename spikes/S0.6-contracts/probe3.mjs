import init, * as sdk from '/Users/pasta/workspace/platform/packages/wasm-sdk/dist/sdk.js';
import { token } from './tokenlib.mjs';
await init();
const O='11111111111111111111111111111111';
const c={ $formatVersion:'1', id:O, ownerId:O, version:1,
  documentSchemas:{ ref:{type:'object',tokenCost:{create:{tokenPosition:0,amount:1},delete:{tokenPosition:0,amount:1}},canBeDeleted:false,documentsMutable:false,properties:{h:{type:'array',byteArray:true,minItems:32,maxItems:32,position:0}},required:['h'],additionalProperties:false} },
  groups:{ 0:{ $formatVersion:'0', members:{ [O]:1 }, requiredPower:1 } },
  tokens:{ 0:token({singular:'write',plural:'writes',owner:O}), 1:token({singular:'maintain',plural:'maintains',owner:O}) },
  keywords:['git'], description:null };
try{ const dc=sdk.DataContract.fromJSON(c,true,9); console.log('PASS bytes',dc.toBytes(9).length); }
catch(e){ console.log('REJECT',(e.message||e).toString().slice(0,300)); }
