/* Offline, self-rated practice. No microphone, MIDI, or automatic assessment. */
(function(root,factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PianoPractice=api;
})(typeof globalThis!=='undefined'?globalThis:this,function() {
  'use strict';
  const SCHEMA=1;
  function hash(value) {
    let n=2166136261;
    for(const c of String(value)) {
      n^=c.charCodeAt(0);
      n=Math.imul(n,16777619);
    }return n>>>0;
  }
  function shuffled(items,seed) {
    const result=items.slice();
    let n=hash(seed)||1;
    const random=()=> {
      n^=n<<13;
      n^=n>>>17;
      n^=n<<5;
      return(n>>>0)/4294967296;
    };
    for(let i=result.length-1;
    i>0;
    i--) {
      const j=Math.floor(random()*(i+1));
      [result[i],result[j]]=[result[j],result[i]];
    }return result;
  }
  function buildCatalog(collection,manifests) {
    const result=[],seen=new Set();
    for(const piece of collection.pieces) {
      const manifest=manifests[piece.slug];
      if(!manifest)throw new Error('Missing manifest: '+piece.slug);
      for(const system of manifest.systems) {
        const key=piece.slug+':'+system.id;
        if(seen.has(key))throw new Error('Duplicate source system: '+key);
        seen.add(key);
        result.push( {
          ...system,key,piece:piece.slug,title:piece.title,scan:piece.directory+'/'+system.scan,score:piece.directory+'/'+system.score
        });
      }
    }
    return result;
  }
  function createSession(catalog,options= {
  }) {
    if(!catalog.length)throw new Error('The practice catalog is empty.');
    const entries=new Map(catalog.map(x=>[x.key,x]));
    if(entries.size!==catalog.length)throw new Error('Source system IDs must be unique.');
    const storage=options.storage===undefined?(typeof localStorage!=='undefined'?localStorage:null):options.storage,key=options.key||'piano-library.practice.v1';
    const seed=options.seed===undefined?String(Date.now()):String(options.seed);
    let persistenceError=null;
    let state= {
      schema:SCHEMA,seed,shuffleCount:0,ratings: {
      },history:[],queue:shuffled([...entries.keys()],seed),cursor:0,mode:'all',round:0,target:8
    };
    function restore(candidate) {
      if(!candidate||candidate.schema!==SCHEMA)throw new Error('Unsupported practice save format.');
      const ratings= {
      };
      for(const [id,value]of Object.entries(candidate.ratings|| {
      })) {
        if(entries.has(id)&&Number.isInteger(value)&&value>=1&&value<=9)ratings[id]=value;
      }
      const queue=(candidate.queue||[]).filter((id,i,a)=>entries.has(id)&&a.indexOf(id)===i);
      const mode=candidate.mode==='floor'?'floor':'all';
      if(mode==='all')for(const id of entries.keys())if(!queue.includes(id))queue.push(id);
      if(!queue.length)queue.push(...entries.keys());
      return {
        schema:SCHEMA,seed:String(candidate.seed||seed),shuffleCount:Math.max(0,Number(candidate.shuffleCount)||0),ratings,history:(candidate.history||[]).filter(x=>entries.has(x.key)&&Number.isInteger(x.score)&&x.score>=1&&x.score<=9),queue,cursor:Math.min(Math.max(0,Number(candidate.cursor)||0),queue.length-1),mode,round:Math.max(0,Number(candidate.round)||0),target:Number.isInteger(candidate.target)&&candidate.target>=1&&candidate.target<=9?candidate.target:8
      };
    }
    if(storage) {
      try {
        const saved=storage.getItem(key);
        if(saved)state=restore(JSON.parse(saved));
      }catch(error) {
        persistenceError='Could not read saved practice: '+error.message;
      }
    }
    function save() {
      if(storage)try {
        storage.setItem(key,JSON.stringify(state));
        persistenceError=null;
      }catch(error) {
        persistenceError='Practice is not saved: '+error.message;
      }return snapshot();
    }
    function snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
    function current() {
      const value=entries.get(state.queue[state.cursor]);
      return {
        ...value,rating:state.ratings[value.key]??null
      };
    }
    function stats() {
      const values=Object.values(state.ratings),floor=state.queue.filter(id=>(state.ratings[id]||0)>=state.target);
      return {
        total:catalog.length,rated:values.length,unrated:catalog.length-values.length,average:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,position:state.cursor+1,queueSize:state.queue.length,mode:state.mode,round:state.round,target:state.target,floorMastered:state.mode==='floor'?floor.length:0,floorComplete:state.mode==='floor'&&floor.length===state.queue.length,persistenceError
      };
    }
    function next(delta=1) {
      state.cursor=(state.cursor+delta%state.queue.length+state.queue.length)%state.queue.length;
      save();
      return current();
    }
    function grade(score,advance=true) {
      if(!Number.isInteger(score)||score<1||score>9)throw new Error('Comfort must be a whole number from 1 to 9.');
      const id=state.queue[state.cursor];
      state.ratings[id]=score;
      state.history.push( {
        key:id,score,at:new Date().toISOString(),round:state.round
      });
      if(advance)state.cursor=(state.cursor+1)%state.queue.length;
      save();
      return current();
    }
    function shuffle() {
      state.shuffleCount++;
      state.queue=shuffled(state.queue,state.seed+':'+state.shuffleCount);
      state.cursor=0;
      save();
      return current();
    }
    function focusLowest(fraction=0.1,target=8) {
      if(!Number.isFinite(fraction)||fraction<=0||fraction>1)throw new Error('Practice fraction must be greater than zero and at most one.');
      if(!Number.isInteger(target)||target<1||target>9)throw new Error('Mastery target must be 1–9.');
      const unrated=catalog.filter(x=>state.ratings[x.key]===undefined);
      if(unrated.length)return {
        ready:false,unrated:unrated.length,message:'Rate the remaining '+unrated.length+' systems before choosing the lowest-scoring group.'
      };
      const order=shuffled([...entries.keys()],state.seed+':floor:'+state.round);
      order.sort((a,b)=>state.ratings[a]-state.ratings[b]);
      state.queue=order.slice(0,Math.max(1,Math.ceil(catalog.length*fraction)));
      state.cursor=0;
      state.mode='floor';
      state.round++;
      state.target=target;
      save();
      return {
        ready:true,count:state.queue.length,current:current()
      };
    }
    function all() {
      state.mode='all';
      state.queue=shuffled([...entries.keys()],state.seed+':all:'+state.shuffleCount);
      state.cursor=0;
      save();
      return current();
    }
    function remainingUnrated() {
      state.mode='all';
      const ids=shuffled([...entries.keys()],state.seed+':unrated:'+state.shuffleCount);
      state.queue=ids.filter(id=>state.ratings[id]===undefined).concat(ids.filter(id=>state.ratings[id]!==undefined));
      state.cursor=0;
      save();
      return current();
    }
    function importJSON(json) {
      const candidate=typeof json==='string'?JSON.parse(json):json;
      state=restore(candidate);
      save();
      return current();
    }
    return {
      current,grade,next,previous:()=>next(-1),shuffle,focusLowest,all,remainingUnrated,stats,snapshot,exportJSON:()=>JSON.stringify(state,null,2),importJSON
    };
  }
  return {
    SCHEMA,shuffled,buildCatalog,createSession
  };
});
