/* Explicit playback routes over source measures. Images and engraving share this route. */
(function(root,factory) {
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PianoPerformance=api;
})(typeof globalThis!=='undefined'?globalThis:this,function() {
  'use strict';
  class NavigationError extends Error {
    constructor(message) {
      super(message);
      this.name='NavigationError';
    }
  }
  function buildRoute(model) {
    const measures=model.measures||[],n=measures.length;
    if(!n)throw new NavigationError('No source measures.');
    if(model.issues&&model.issues.length)throw new NavigationError(model.issues.join('; '));
    const blocks=model.repeats||[],endings=model.endings||[],starts=new Map(),ends=new Map();
    const fail=message=> {
      throw new NavigationError(message);
    };
    for(const b of blocks) {
      if(!Number.isInteger(b.start)||!Number.isInteger(b.end)||b.start<0||b.end>=n||b.start>b.end||!Number.isInteger(b.times||2)||(b.times||2)<2)fail('Invalid repeat block.');
      if(ends.has(b.end))fail('Two repeats end at the same measure.');
      if(!starts.has(b.start))starts.set(b.start,[]);
      starts.get(b.start).push(b);
      ends.set(b.end,b);
    }
    for(let a=0;
    a<blocks.length;
    a++)for(let b=a+1;
    b<blocks.length;
    b++) {
      const x=blocks[a],y=blocks[b];
      if(x.start<y.start&&y.start<=x.end&&x.end<y.end||y.start<x.start&&x.start<=y.end&&y.end<x.end)fail('Crossing repeats are ambiguous.');
    }
    const segnos=new Map(),codas=new Map();
    for(let i=0;
    i<n;
    i++) {
      const m=measures[i];
      for(const [map,value]of [[segnos,m.segno],[codas,m.coda]])if(value) {
        if(map.has(value))fail('Duplicate navigation destination '+value);
        map.set(value,i);
      }
    }
    for(const e of endings)if(!Number.isInteger(e.start)||!Number.isInteger(e.end)||e.start<0||e.end>=n||e.start>e.end||!Array.isArray(e.passes)||!e.passes.length||e.passes.some(p=>!Number.isInteger(p)||p<1))fail('Invalid numbered ending.');
    const route=[],transitions=[],frames=[],lastPass=new Map(),visits=new Map();
    let pc=0,afterJump=false,codaTaken=false,jumpTaken=false;
    const limit=model.maxSteps||Math.max(n*32,1000);
    while(pc<n) {
      if(route.length>limit)fail('Navigation exceeded its safety bound.');
      const visitKey=[pc,afterJump,codaTaken,frames.map(f=>f.block.start+':'+f.pass).join(',')].join('|');
      const count=(visits.get(visitKey)||0)+1;
      visits.set(visitKey,count);
      if(count>2)fail('Navigation loop at source measure '+(pc+1));
      if(!afterJump||model.repeatAfterJump) {
        for(const b of(starts.get(pc)||[]).slice().sort((a,b)=>b.end-a.end))if(!frames.some(f=>f.block===b))frames.push( {
          block:b,pass:1
        });
      }
      let skipped=false;
      for(const e of endings.filter(x=>x.start===pc)) {
        const frame=[...frames].reverse().find(f=>e.repeatStart===undefined?f.block.start<=e.start:f.block.start===e.repeatStart);
        const pass=frame?frame.pass:(lastPass.get(e.repeatStart)||1);
        if(!e.passes.includes(pass)) {
          const from=pc;
          pc=e.end+1;
          while(frames.length&&frames[frames.length-1].block.end<pc) {
            const f=frames.pop();
            lastPass.set(f.block.start,f.pass);
          }transitions.push( {
            after:route.length-1,kind:'ending-skip',from,to:pc,pass
          });
          skipped=true;
          break;
        }
      }
      if(skipped)continue;
      const m=measures[pc];
      route.push(pc);
      if(m.fine&&afterJump) {
        transitions.push( {
          after:route.length-1,kind:'fine',from:pc,to:null
        });
        break;
      }
      if(m.toCoda&&afterJump&&!codaTaken) {
        const target=codas.get(m.toCoda);
        if(target===undefined)fail('Missing Coda destination '+m.toCoda);
        transitions.push( {
          after:route.length-1,kind:'coda',from:pc,to:target
        });
        pc=target;
        codaTaken=true;
        frames.length=0;
        continue;
      }
      if(m.jump&&!jumpTaken) {
        let target;
        if(m.jump.kind==='DC')target=0;
        else if(m.jump.kind==='DS')target=segnos.get(m.jump.target);
        else fail('Unsupported jump '+m.jump.kind);
        if(target===undefined)fail('Missing Segno destination '+m.jump.target);
        transitions.push( {
          after:route.length-1,kind:m.jump.kind,from:pc,to:target
        });
        pc=target;
        afterJump=true;
        jumpTaken=true;
        frames.length=0;
        continue;
      }
      const b=ends.get(pc);
      if(b&&(!afterJump||model.repeatAfterJump)) {
        const frame=frames.find(f=>f.block===b);
        if(!frame)fail('Unmatched backward repeat at source measure '+(pc+1));
        if(frame.pass<(b.times||2)) {
          frame.pass++;
          transitions.push( {
            after:route.length-1,kind:'repeat',from:pc,to:b.start,pass:frame.pass
          });
          pc=b.start;
          continue;
        }lastPass.set(b.start,frame.pass);
        frames.splice(frames.indexOf(frame),1);
      }
      pc++;
    }
    return {
      schema:1,measures:route,transitions,sourceMeasureCount:n,performedMeasureCount:route.length
    };
  }
  function sliceRoute(route,manifest) {
    const source=Array.isArray(route)?route:route.measures,lookup=new Map();
    for(const system of manifest.systems)for(let i=system.first;
    i<=system.last;
    i++) {
      if(lookup.has(i))throw new NavigationError('Overlapping source systems.');
      lookup.set(i,system);
    }
    const slices=[];
    for(let i=0;
    i<source.length;
    i++) {
      const measure=source[i],system=lookup.get(measure);
      if(!system)throw new NavigationError('No source system for measure '+(measure+1));
      const prior=slices[slices.length-1];
      if(prior&&prior.systemId===system.id&&prior.last+1===measure) {
        prior.last=measure;
        prior.routeLast=i;
      }else slices.push( {
        id:'visit-'+slices.length,systemId:system.id,first:measure,last:measure,routeFirst:i,routeLast:i,sourceFirst:system.first,sourceLast:system.last,scan:system.scan,score:system.score
      });
    }
    return slices;
  }
  function pages(slices,systemsPerPage=4) {
    if(!Number.isInteger(systemsPerPage)||systemsPerPage<1)throw new Error('Systems per page must be positive.');
    const result=[];
    for(let i=0;
    i<slices.length;
    i+=systemsPerPage)result.push(slices.slice(i,i+systemsPerPage));
    return result;
  }
  function spreads(slices,systemsPerPage=4) {
    const p=pages(slices,systemsPerPage),result=[];
    for(let i=0;
    i<p.length;
    i+=2)result.push([p[i],p[i+1]||[]]);
    return result;
  }
  return {
    NavigationError,buildRoute,sliceRoute,pages,spreads
  };
});
