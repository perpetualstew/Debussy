'use strict';
/* Post-layout, read-only attachment geometry audit.
 * Never reparses or rewrites a musical event; never translates any SVG item.
 * Measurements are screen coordinates, not untransformed SVG attributes.
 * Separate hard structural errors from positioning candidates requiring visual review.
 */
(function () {
  const $=(root,sel)=>Array.from(root?.querySelectorAll(sel)||[]);
  const valid=r=>[r.left,r.top,r.right,r.bottom,r.width,r.height].every(Number.isFinite);
  const bbox=n=>n.getBoundingClientRect();
  const visible=n=>{
    if(n.closest('[style*="visibility: hidden"]'))return false;
    const s=getComputedStyle(n);
    return s.display!=='none' && s.visibility!=='hidden' && Number(s.opacity||'1')!==0;
  };
  const near=(a,b)=>Math.max(0,Math.max(a.left-b.right,b.left-a.right));
  const symTypes={
    fermata:'g.fermata',articulation:'g.artic',ornament:'g.ornam, g.trill',
    dynamic:'g.dynam',direction:'g.dir',tuplet:'g.tupletNum',
    arpeggio:'g.arpeg',tie:'g.tie',slur:'g.slur'
  };
  let latest=null;
  const history=[];
  function inspect(system={},opts={}){
    const svg=document.querySelector('#notation svg');
    if(!svg)return null;
    const measures=$(svg,'g.measure');
    const image=document.querySelector('#scan');
    const ref=bbox(image), natural=image?.naturalWidth||Number(system.scanWidthPx)||2300;
    const gap=Number(system.scanStaffSpacePx||17)*ref.width/natural;
    const bars=(system.barlines||[]).map(x=>ref.left+x*ref.width);
    const aligned=(system.reviewMode==='aligned'||system.alignmentPilot===true) && bars.length===measures.length+1;
    const problems=[],counts={},positions=[];
    const warn=(code,mi,kind,detail)=>problems.push({level:'review',code,measure:Number(system.first||0)+mi+1,kind,...detail});
    const fail=(code,mi,kind,detail)=>problems.push({level:'error',code,measure:Number(system.first||0)+mi+1,kind,...detail});
    let total=0;
    measures.forEach((measure,mi)=>{
      const notes=$(measure,'g.note, g.rest, g.mRest').filter(visible);
      const noteHeads=notes.map(n=>n.querySelector('g.notehead')||n).map(bbox).filter(r=>valid(r)&&r.width>0);
      for(const [kind,selector] of Object.entries(symTypes)){
        const nodes=$(measure,selector).filter(n=>!n.parentElement?.closest(selector) && visible(n));
        counts[kind]=(counts[kind]||0)+nodes.length;
        for(const [index,node] of nodes.entries()){
          const r=bbox(node);
          if(!valid(r)){fail('NONFINITE_BOUNDS',mi,kind,{index});continue;}
          if(r.width<.01||r.height<.01){continue;}
          total++;
          const edited=node.dataset.positionOverride==='true' || node.closest('[data-position-override="true"]')!==null;
          // The Position Editor deliberately permits offsets. Record these as
          // manual placements, never interpret them as automatic layout faults.
          const geometry={kind,measure:Number(system.first||0)+mi+1,index,
            x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),edited};
          if(opts.includePositions)positions.push(geometry);
          if(!aligned||edited)continue;
          const left=bars[mi],right=bars[mi+1];
          // Large text, slurs and ties may legitimately extend across measure
          // boundaries. Only report *short* independent symbols well outside.
          if(['fermata','articulation','ornament','dynamic','tuplet','arpeggio'].includes(kind) &&
             r.width<Math.max(8*gap,(right-left)*.75)){
            if(r.left>right+Math.max(2.5*gap,22) || r.right<left-Math.max(2.5*gap,22))
              fail('DETACHED_OUTSIDE_MEASURE',mi,kind,{index,offsetPx:Math.round(r.left>right?r.left-right:left-r.right)});
            else if((r.left+r.right)/2>right+gap*.9 || (r.left+r.right)/2<left-gap*.9)
              warn('BOUNDARY_PROXIMITY',mi,kind,{index});
          }
          if(['fermata','articulation','ornament','arpeggio','tuplet'].includes(kind) && noteHeads.length){
            const closest=Math.min(...noteHeads.map(h=>near(h,r)));
            if(closest>Math.max(6.5*gap,64) && r.width<8*gap)
              warn('FAR_FROM_NOTE_COLUMN',mi,kind,{index,distancePx:Math.round(closest)});
          }
        }
      }
      // A note accidental is attached *inside* its g.note/chord. If the note
      // itself moves but its accidental escapes its note box, flag that separately.
      for(const [index,note] of notes.entries()){
        if(!note.classList.contains('note'))continue;
        const head=bbox(note.querySelector('g.notehead')||note);
        for(const acc of $(note,'g.accid').filter(visible)){
          const r=bbox(acc);
          if(valid(r)&&valid(head) && r.width>0 && near(head,r)>Math.max(5*gap,50))
            fail('DETACHED_ACCIDENTAL',mi,'accidental',{index,distancePx:Math.round(near(head,r))});
        }
      }
      // A visible, un-reconstructed native tie can be left at its old x after
      // note reflow. Flag without modifying it; zero-size跨-system ties are ignored.
      if(aligned){
        for(const [index,tie] of $(measure,'g.tie').filter(visible).entries()){
          const r=bbox(tie);
          if(valid(r)&&r.width>1.5 && !tie.closest('.pl-tie-geometry'))
            warn('NATIVE_TIE_SURVIVES_ALIGNMENT',mi,'tie',{index});
        }
      }
    });
    if(aligned && (opts.uncertainIDs||[]).length)
      warn('PROVISIONAL_EVENT_POSITIONS',Math.max(0,Number((opts.uncertainIDs[0]||'').match(/^p0-m(\d+)-n/)?.[1]||system.first)-Number(system.first)), 'notation',{count:opts.uncertainIDs.length,ids:opts.uncertainIDs.slice(0,8)});
    const unresolved=String(opts.alignmentReport||'').match(/unplaced:\s*([^·]+)/);
    if(aligned && unresolved)warn('UNRESOLVED_LAYOUT_ATTACHMENTS',0,'notation',{summary:unresolved[1].trim()});
    const report={piece:system.pieceSlug||'',system:(Number(system.system)||0)||null,
      first:Number(system.first||0)+1,last:Number(system.last||0)+1,aligned,
      measured:total,counts,problems,positions:opts.includePositions?positions:undefined};
    latest=report;history.push(report);if(history.length>320)history.shift();
    svg.dataset.attachmentAuditErrors=String(problems.filter(p=>p.level==='error').length);
    svg.dataset.attachmentAuditReviews=String(problems.filter(p=>p.level==='review').length);
    if(problems.some(p=>p.level==='error') && !opts.quiet)
      console.warn('Piano attachment audit:',system.pieceSlug,report.first,problems);
    return report;
  }
  window.PianoAttachmentAudit={inspect,latest:()=>latest,history:()=>history.slice(),
    exportJSON:()=>JSON.stringify(history,null,2)};
})();
