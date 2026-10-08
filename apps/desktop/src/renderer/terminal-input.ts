/** xterm emits both user data and automatic terminal protocol replies. */
export function terminalDataAction(data:string,userIntent:boolean):'input'|'response'|'ignore'{
 if(/^\x1b\[[0-9;]*[RnIOc]$/.test(data))return 'response';
 return data&&userIntent?'input':'ignore';
}
