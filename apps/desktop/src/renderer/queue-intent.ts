/** Keep an unacknowledged submission stable across retries and reloads. */
export function queueIntent(owner:string,payload:{text:string;attachments:{path:string}[];mode:string;planMode:boolean}){
 const key='friend-pi.queue-intent.v1:'+owner,identity=JSON.stringify({...payload,attachments:payload.attachments.map(file=>file.path)});let prior:{id:string;identity:string}|undefined;
 try{prior=JSON.parse(localStorage.getItem(key)||'null')||undefined;}catch{}
 const id=prior?.identity===identity?prior.id:crypto.randomUUID();localStorage.setItem(key,JSON.stringify({id,identity}));return {id,key};
}
export function acknowledgeQueueIntent(intent:{id:string;key:string}){try{if(JSON.parse(localStorage.getItem(intent.key)||'null')?.id===intent.id)localStorage.removeItem(intent.key);}catch{}}

export function hasQueueIntent(owner:string,payload:{text:string;attachments:{path:string}[];mode:string;planMode:boolean}){try{return JSON.parse(localStorage.getItem('friend-pi.queue-intent.v1:'+owner)||'null')?.identity===JSON.stringify({...payload,attachments:payload.attachments.map(file=>file.path)});}catch{return false;}}
