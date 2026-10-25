import './sandbox-events.js';
import * as chai from 'chai';
const responseObject = object => object && object.__reaResponse === true;
chai.Assertion.addMethod('status',function(expected){const actual=this._obj.code;this.assert(Array.isArray(expected)?expected.includes(actual):actual===expected,`expected status ${JSON.stringify(expected)}, got ${actual}`,`expected status not to be ${JSON.stringify(expected)}`);});
chai.Assertion.addMethod('header',function(name,value){const actual=this._obj.headers.get(name);this.assert(value===undefined?actual!==undefined:actual?.includes(value),`expected header ${name} to match ${value}`,`expected header ${name} not to match ${value}`);});
chai.Assertion.addMethod('body',function(value){const actual=this._obj.text();this.assert(value===undefined?actual.length>0:actual===value,'expected response body to match','expected response body not to match');});
chai.Assertion.addProperty('json',function(){let valid=true;try{this._obj.json();}catch{valid=false;}this.assert(valid,'expected JSON response','expected non-JSON response');});
chai.Assertion.overwriteProperty('ok',superMethod=>function(){if(responseObject(this._obj))this.assert(this._obj.code>=200&&this._obj.code<300,'expected successful response','expected unsuccessful response');else superMethod.call(this);});
globalThis.__reaBootstrap = input => {
 const observeSecret=typeof __reaSecret==='function'?__reaSecret:null;
 const state={environment:Object.assign(Object.create(null),input.environment),collection:Object.assign(Object.create(null),input.collection),globals:Object.assign(Object.create(null),input.globals),local:Object.assign(Object.create(null),input.local),data:Object.assign(Object.create(null),input.data),testResults:[],logs:[],pending:0};
 const recordError=(name,error)=>state.testResults.push({name,passed:false,error:String(error?.message||error)});
 const scope=(object,readOnly=false)=>({get:key=>object[key],has:key=>Object.hasOwn(object,key),set:(key,value)=>{if(readOnly)throw new Error('Iteration data is read-only');object[key]=String(value);observeSecret?.(String(key),object[key]);},unset:key=>{if(!readOnly)delete object[key];},clear:()=>{if(!readOnly)Object.keys(object).forEach(k=>delete object[k]);},toObject:()=>({...object}),replaceIn:text=>String(text).replace(/{{\s*([^{}]+?)\s*}}/g,(all,key)=>object[key]??all)});
 const all=()=>({...state.globals,...state.collection,...state.environment,...state.data,...state.local});
 const response=raw=>{const headers=raw.headers||{};return {...raw,__reaResponse:true,status:raw.statusText,headers:{...headers,get:name=>Object.entries(headers).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1],has:name=>Object.keys(headers).some(key=>key.toLowerCase()===name.toLowerCase())},json:()=>JSON.parse(raw.body),text:()=>raw.body,get to(){return chai.expect(this).to;}};};
 const pending=promise=>{state.pending++;return Promise.resolve(promise).finally(()=>state.pending--);};
 const bridge=argument=>{if(typeof __reaAsyncBridge!=='function')throw new Error('Async APIs require executeAsync');return pending(__reaAsyncBridge(JSON.stringify(argument)).then(JSON.parse));};
 globalThis.pm={
  environment:scope(state.environment),collectionVariables:scope(state.collection),globals:scope(state.globals),iterationData:scope(state.data,true),
  variables:{...scope(state.local),get:key=>all()[key],has:key=>Object.hasOwn(all(),key),toObject:all,replaceIn:text=>String(text).replace(/{{\s*([^{}]+?)\s*}}/g,(allText,key)=>all()[key]??allText)},
  expect:chai.expect,info:input.info||{},request:input.request||{},
  response:input.response?response(input.response):undefined,
  execution:{setNextRequest:value=>state.nextRequest=value==null?null:String(value),skipRequest:()=>state.skipRequest=true},
  sendRequest:(request,callback)=>{const task=bridge({kind:'request',request}).then(raw=>{const value=response(raw);if(callback)callback(null,value);return value;},error=>{if(callback){callback(error);return;}throw error;});return pending(task);},
  test:(name,fn)=>{
   if(state.testResults.length>=1000)throw new Error('Maximum 1000 assertions per script');
   let finished=false;const finish=error=>{if(finished)return;finished=true;error?recordError(name,error):state.testResults.push({name,passed:true});};
   try{if(fn.length){state.pending++;try{fn(error=>{if(!finished){finish(error);state.pending--;}});}catch(error){if(!finished){finish(error);state.pending--;}}}else {const result=fn();if(result?.then)pending(result).then(()=>finish(),finish);else finish();}}catch(error){finish(error);}
  }
 };
 globalThis.postman={setNextRequest:pm.execution.setNextRequest};
 globalThis.setTimeout=(callback,ms=0,...args)=>bridge({kind:'sleep',ms}).then(()=>{callback(...args);}).catch(error=>recordError('Timer',error));
 globalThis.console=Object.fromEntries(['log','warn','error','info','debug'].map(level=>[level,(...args)=>{if(state.logs.length<1000)state.logs.push((level==='log'?'':`[${level.toUpperCase()}] `)+args.map(value=>typeof value==='object'?JSON.stringify(value):String(value)).join(' ').slice(0,4096));}]));
 globalThis.__reaResult=()=>({...state,updatedEnvironment:state.environment,updatedCollectionVariables:state.collection,updatedGlobals:state.globals,updatedLocalVariables:state.local,updatedVariables:all()});
 globalThis.__reaRecordError=recordError;
};
