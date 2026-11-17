// SPDX-License-Identifier: MIT
// Dataset and algorithm ported from pinned Phoenix AGI World Intel (MIT).
import {readFileSync} from 'node:fs';
import type {DomainHandlers} from '../domain-runtime.js';
const data=JSON.parse(readFileSync(new URL('../../data/society/elections.json',import.meta.url),'utf8')) as Record<string,any>[];
export function createElectionHandlers(now=()=>new Date()):DomainHandlers{return{intel_election_calendar:args=>{
 const date=now(),today=Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()),filter=String(args.country??'').toLowerCase().trim();
 const elections=data.filter(e=>!filter||e.country.toLowerCase().includes(filter)||e.iso3.toLowerCase()===filter).map(e=>{const days_until=Math.round((Date.parse(e.date)-today)/86400000),absolute=Math.abs(days_until),base=absolute<=30?100:absolute<=90?70:absolute<=180?40:absolute<=365?20:5;return {...e,days_until,status:days_until<0?'past':'upcoming',risk_score:base*({high:1.5,medium:1,low:.6}[e.instability_impact as string]??1)};}).sort((a,b)=>b.risk_score-a.risk_score);
 return{elections,count:elections.length,highest_risk:elections[0]??null,source:'election-calendar',timestamp:date.toISOString().replace(/\.\d{3}Z$/,'Z')};
}};}
