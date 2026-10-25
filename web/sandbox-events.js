// Chai 6 plugin notifications use EventTarget; QuickJS has no browser DOM.
// These objects stay inside the interpreter, with no host references.
if(typeof globalThis.Event==='undefined')globalThis.Event=class Event{constructor(type){this.type=type;}};
if(typeof globalThis.EventTarget==='undefined')globalThis.EventTarget=class EventTarget{
 constructor(){this.listeners=new Map();}
 addEventListener(type,callback){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(callback);}
 removeEventListener(type,callback){this.listeners.get(type)?.delete(callback);}
 dispatchEvent(event){for(const callback of this.listeners.get(event.type)||[])callback.call(this,event);return true;}
};
