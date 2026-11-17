// SPDX-License-Identifier: MIT
import {describe,it,expect}from'vitest';
import {NewsClient,RSS_FEEDS,parseFeed,outletFor}from'../src/domains/news.js';
import {createSynthesisHandlers}from'../src/domains/synthesis.js';
const rss='<rss><channel><item><title>Ukraine earthquake earthquake</title><link>https://example.org/a</link><pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate><description>News &amp; more</description></item></channel></rss>';
describe('native news',()=>{
 it('preserves119 feed definitions and publisher identities',()=>{expect(Object.values(RSS_FEEDS).flat()).toHaveLength(119);expect(outletFor('BBC Mundo')).toBe('BBC');});
 it('parses RSS and Atom, sanitizes links and rejects declarations',()=>{
  expect(parseFeed(rss,'BBC World','geopolitics')[0]).toMatchObject({published:'2026-11-16T12:00:00Z',summary:'News & more',source_tier:'major'});
  const atom='<feed><entry><title>Atom</title><link href="javascript:alert(1)"/><updated>2026-11-16T01:00:00Z</updated><summary>text</summary></entry></feed>';expect(parseFeed(atom,'x','y')[0]).toMatchObject({title:'Atom',link:'',published:'2026-11-16T01:00:00Z'});
  expect(()=>parseFeed('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>','x','y')).toThrow('DTD');
 });
 it('shares concurrent feed reads, caches results and copies mutable items',async()=>{
  let requests=0;const c=new NewsClient({fetch:async()=>{requests++;return new Response(rss);}});const [a,b]=await Promise.all([c.newsFeed({category:'geopolitics'}),c.newsFeed({category:'geopolitics',limit:1})]);expect(requests).toBe(RSS_FEEDS.geopolitics.length);expect(a.feeds_ok).toBe(requests);a.items[0].title='changed';expect(b.items[0].title).not.toBe('changed');await c.newsFeed({category:'geopolitics'});expect(requests).toBe(RSS_FEEDS.geopolitics.length);
 });
 it('distinguishes outages and stale fallback from a quiet feed',async()=>{
  let time=0,fail=false;const c=new NewsClient({now:()=>new Date(time),fetch:async()=>{if(fail)throw new Error('offline');return new Response(rss);}});await c.newsFeed({category:'geopolitics'});time=301000;fail=true;const r=await c.newsFeed({category:'geopolitics'});expect(r).toMatchObject({degraded:true,reason:'all_feeds_failed',feeds_ok:0});expect(r.items.length).toBeGreaterThan(0);expect(r.feeds_stale).toHaveLength(RSS_FEEDS.geopolitics.length);
  const cold=new NewsClient({fetch:async()=>{throw new Error('offline');}});expect(await cold.newsFeed({category:'geopolitics'})).toMatchObject({count:0,degraded:true,reason:'all_feeds_failed'});
 });
 it('feeds native trending into spike detection using upstream word/count shape',async()=>{
  const c=new NewsClient({fetch:async()=>new Response(rss)});const trends=await c.trendingKeywords({min_count:3});expect(trends.keywords[0]).toHaveProperty('word');const h=createSynthesisHandlers({newsFeed:a=>c.newsFeed(a),trendingKeywords:a=>c.trendingKeywords(a)});const r:any=await h.intel_keyword_spikes({});expect(r.keywords_analyzed).toBeGreaterThan(0);expect(r.spike_count).toBe(0);
 });
 it('keeps distinct GDELT query cache and explicit failure semantics',async()=>{
  const queries:string[]=[];const c=new NewsClient({fetch:async input=>{queries.push(String(input));return new Response(JSON.stringify({articles:[{title:new URL(String(input)).searchParams.get('query')}]}));}});expect((await c.gdeltSearch({query:'Київ'})).articles[0].title).toBe('Київ');expect((await c.gdeltSearch({query:'Суми'})).articles[0].title).toBe('Суми');expect(queries).toHaveLength(2);const broken=new NewsClient({fetch:async()=>new Response('not json')});expect(await broken.gdeltSearch()).toMatchObject({degraded:true,reason:'gdelt_fetch_failed'});
 });
});
