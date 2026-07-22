import init, * as sdk from '/Users/pasta/workspace/platform/packages/wasm-sdk/dist/sdk.js';
await init();
const c = {
  $formatVersion: '1', id: '11111111111111111111111111111111', ownerId: '11111111111111111111111111111111',
  version: 1, documentSchemas: { note: { type:'object', properties:{ m:{type:'string',maxLength:10,position:0} }, required:['m'], additionalProperties:false } }
};
try {
  const dc = sdk.DataContract.fromJSON(c, true, 9);
  console.log('OK id', dc.id.toBase58(), 'bytes', dc.toBytes(9).length);
} catch(e){ console.log('ERR', e.message||e); }
