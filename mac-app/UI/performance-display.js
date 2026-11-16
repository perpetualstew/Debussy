/* Display-only pagination. Source systems, routes and practice data are unchanged. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PianoPerformanceDisplay=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const profiles={
    'monitor-16-9':{label:'16:9 monitor',columns:2,adaptive:true,reflow:true,defaultSize:45},
    sidetrak:{label:'SideTrak',columns:2,adaptive:false,defaultSize:45}
  };
  const size=value=>Math.max(30,Math.min(70,Number(value)||45));
  function paginate(score,profile,viewport,value){
    const p=profiles[profile]||profiles.sidetrak,s=size(value);
    if(!p.adaptive){const rows=Math.max(2,Math.min(7,Math.round(180/s))),out=[];for(let i=0;i<score.performance.length;i+=rows)out.push(score.performance.slice(i,i+rows));return out;}
    // The size slider changes both the number of systems and their actual
    // scale. Smaller settings offer more preview; larger settings prioritize ink.
    const width=Math.max(200,viewport.width),height=Math.max(120,viewport.height);
    const requestedRows=Math.max(1,Math.min(4,Math.round(90/s)));
    const usableWidth=width*Math.min(1,.62+s/120),gap=12;
    const pages=[];let page=[],used=0;
    for(const slice of score.performance){
      const system=score.systems[slice.systemId];if(!system||!(system.width>0&&system.height>0))throw Error('Missing finished system '+slice.systemId);
      const h=system.height/system.width*usableWidth+gap;
      if(page.length&&(page.length>=requestedRows||used+h>height)){pages.push(page);page=[];used=0;}
      page.push(slice);used+=h;
    }
    if(page.length)pages.push(page);return pages;
  }
  function cursor(pages,screen,columns){return pages.slice(0,screen*columns).reduce((n,p)=>n+p.length,0);}
  function screenForCursor(pages,offset,columns){let n=0;for(let i=0;i<pages.length;i++){n+=pages[i].length;if(offset<n)return Math.floor(i/columns);}return Math.max(0,Math.ceil(pages.length/columns)-1);}
  return {profiles,size,paginate,cursor,screenForCursor};
});
