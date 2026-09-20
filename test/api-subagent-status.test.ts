import 'reflect-metadata';
import { expect, it } from 'vitest';
import { ApiController } from '../server/api.controller.js';
it('does not resurrect old unfinished subagents when their parent starts another turn', () => {
  const controller=Object.create(ApiController.prototype);
  const now=Date.now();
  const state: Record<string,any>={old:{done:false,status:'running'},fresh:{done:false,status:'running'},done:{done:true},tracked:{done:false,status:'running'},stopped:{done:false,status:'stopped'}};
  controller.manager={
    historyContext:()=>({providerSessionId:'p',configDirs:[],adapter:{id:'fixture',listSubagents:()=>Object.keys(state).map(agentId=>({agentId,updatedAt:agentId==='fresh'?now:now-86400000})),subagentStatus:(_:any,_p:any,id:string)=>state[id]}}),
    isSessionRunning:()=>true,subagentRunning:(_:any,id:string)=>id==='tracked'?true:undefined,
  };
  const states=Object.fromEntries(controller.conversationSubagents('p','s').subagents.map((s:any)=>[s.agentId,s.status]));
  expect(states).toEqual({old:'unknown',fresh:'running',done:'done',tracked:'running',stopped:'stopped'});
});
