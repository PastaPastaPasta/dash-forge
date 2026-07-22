import init, * as sdk from '/Users/pasta/workspace/platform/packages/wasm-sdk/dist/sdk.js';
await init();
const OWNER='11111111111111111111111111111111';
function mk(schemas, tokens){ const c={$formatVersion:'1',id:OWNER,ownerId:OWNER,version:1,documentSchemas:schemas}; if(tokens)c.tokens=tokens; return c; }
function test(name, schemas, tokens){
  try { sdk.DataContract.fromJSON(mk(schemas,tokens), true, 9); console.log('PASS  ', name); }
  catch(e){ console.log('REJECT', name, '::', (e.message||e).toString().slice(0,160)); }
}
// 1. string array
test('string-array', { t:{type:'object',properties:{topics:{type:'array',items:{type:'string',maxLength:30},maxItems:10,position:0}},required:[],additionalProperties:false} });
// 2. desc in index
test('index-desc', { t:{type:'object',properties:{a:{type:'string',maxLength:10,position:0}},indices:[{name:'i',properties:[{a:'desc'}]}],required:[],additionalProperties:false} });
// 3. index asc ok
test('index-asc', { t:{type:'object',properties:{a:{type:'string',maxLength:10,position:0}},indices:[{name:'i',properties:[{a:'asc'}]}],required:[],additionalProperties:false} });
// 4. tokenCost.create without token defined
test('tokenCost-no-token', { t:{type:'object',tokenCost:{create:{tokenPosition:0,amount:1}},properties:{a:{type:'string',maxLength:10,position:0}},required:[],additionalProperties:false} });
// 5. byteArray array ok
test('bytearray-array', { t:{type:'object',properties:{h:{type:'array',byteArray:true,minItems:32,maxItems:32,position:0}},required:[],additionalProperties:false} });
// 6. countable string on unique compound index
test('countable-unique', { t:{type:'object',documentsMutable:true,properties:{a:{type:'string',maxLength:10,position:0}},indices:[{name:'i',properties:[{$ownerId:'asc'},{a:'asc'}],unique:true,countable:'countable'}],required:[],additionalProperties:false} });
// 7. canBeDeleted:false
test('canBeDeleted-false', { t:{type:'object',canBeDeleted:false,documentsMutable:false,properties:{a:{type:'string',maxLength:10,position:0}},required:[],additionalProperties:false} });
// 8. documentsKeepHistory true
test('keepHistory', { t:{type:'object',documentsKeepHistory:true,properties:{a:{type:'string',maxLength:10,position:0}},required:[],additionalProperties:false} });
