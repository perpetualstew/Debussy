'use strict';
/* Piano Library: geometry is calculated once from musical anchors. This module
   has no browser dependencies; the same functions run in Node regression tests. */
(function(root){
  const finite = Number.isFinite;
  function interpolateShift(points, x) {
    const p=points.filter(a=>finite(a.x)&&finite(a.dx)).sort((a,b)=>a.x-b.x);
    if(!p.length)return null;
    if(x<=p[0].x)return p[0].dx;
    if(x>=p[p.length-1].x)return p[p.length-1].dx;
    for(let i=1;i<p.length;i++)if(x<=p[i].x){
      const a=p[i-1],b=p[i],t=(x-a.x)/(b.x-a.x||1);
      return a.dx+(b.dx-a.dx)*t;
    }
    return null;
  }
  // Every beam polygon is owned by one/two *original* stem endpoints. A shape
  // shorter than half a stem interval is a hook and moves rigidly with one stem.
  function beamAssignment(stems,left,right) {
    const s=stems.filter(a=>finite(a.x)&&finite(a.dx)).sort((a,b)=>a.x-b.x);
    if(s.length<1||!finite(left)||!finite(right)||right<=left)return null;
    const gaps=s.slice(1).map((v,i)=>v.x-s[i].x).filter(x=>x>1).sort((a,b)=>a-b);
    const gap=gaps.length?gaps[Math.floor(gaps.length/2)]:25;
    const nearest=x=>s.reduce((a,b)=>Math.abs(a.x-x)<=Math.abs(b.x-x)?a:b);
    const first=nearest(left),last=nearest(right),width=right-left;
    if(first===last || width<gap*.47){
      const owner=nearest((left+right)/2);
      return Math.abs(owner.x-(left+right)/2)<=Math.max(20,gap*.75)
        ?{kind:'hook',dx:owner.dx}:null;
    }
    // Reject the wrong stem, flipped order, or a gross mismatch instead of
    // propagating a beam across a measure. The original remains as fallback.
    if(first.x>=last.x||Math.abs(first.x-left)>Math.max(15,gap*.48)||
       Math.abs(last.x-right)>Math.max(15,gap*.48))return null;
    return {kind:'span',dxL:first.dx,dxR:last.dx};
  }
  // 32nd-note tertiary beams often terminate inset from a stem. The strict
  // matcher can reject them although the neighboring stem identity is clear.
  // Never extrapolate past the beam's parent stem run.
  function beamAssignment32(stems,left,right) {
    const s=stems.filter(v=>finite(v.x)&&finite(v.dx)).sort((a,b)=>a.x-b.x);
    if(s.length<2||!finite(left)||!finite(right)||right<=left)return null;
    const gaps=s.slice(1).map((v,i)=>v.x-s[i].x).filter(x=>x>1);
    const gap=gaps.length?gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)]:25;
    if(left<s[0].x-gap*.35||right>s[s.length-1].x+gap*.35)return null;
    const nearest=x=>s.reduce((a,b)=>Math.abs(a.x-x)<=Math.abs(b.x-x)?a:b);
    const a=nearest(left),b=nearest(right),tol=Math.max(14,gap*.9);
    if(a===b && (right-left)<gap*.48 && Math.abs((left+right)/2-a.x)<tol)
      return {kind:'hook',dx:a.dx};
    if(a.x<b.x&&Math.abs(a.x-left)<=tol&&Math.abs(b.x-right)<=tol)
      return {kind:'span',dxL:a.dx,dxR:b.dx};
    return null;
  }
  function warpPolygonPoints(points, shiftL,shiftR,screenScale){
    if(!finite(screenScale)||Math.abs(screenScale)<1e-9)return null;
    const xs=points.map(p=>p[0]),lo=Math.min(...xs),hi=Math.max(...xs);
    if(!(hi>lo))return null;
    return points.map(([x,y])=>{
      const f=(x-lo)/(hi-lo);
      return [x+((1-f)*shiftL+f*shiftR)/screenScale,y];
    });
  }
  function readPolygon(s){
    if(typeof s!=='string')return null;
    const raw=s.trim().split(/\s+/).map(p=>p.split(',').map(Number));
    return raw.length>=3 && raw.every(p=>p.length===2&&p.every(finite))?raw:null;
  }
  function drawPolygon(pts){return pts.map(([x,y])=>`${+x.toFixed(4)},${+y.toFixed(4)}`).join(' ');}
  // The opening column has to clear its own clef/key and accidentals, not just
  // the barline. A soft local correction is never allowed to change barlines.
  function openingClearance(bar,targets,minGap,maxShift){
    if(!targets.length)return 0;
    const min=Math.min(...targets.map(t=>t.left));
    const need=bar+minGap-min;
    return need>0&&need<=maxShift?need:0;
  }
  // U+1D169 retains the actual Noto Music stroke contours and their 298-unit
  // width. To accommodate the extra ink of v39 without welding the slashes
  // together, v40 spaces the upper and lower contours away from the middle by
  // 65 font units EACH, preserving their width, thickness and inclination.
  // Font y-bounds are consequently 322..933 rather than 387..868. The SVG
  // transform remains uniformly scaled; nothing is squashed or stretched.
  function threeStrokeGlyphPose(stemX,tipY,staffSpace,stemUp){
    if(![stemX,tipY,staffSpace].every(finite)||staffSpace<=0)return null;
    const scale=staffSpace*1.10/298;
    const width=298*scale,height=(933-322)*scale;
    const glyphTop=stemUp?tipY+staffSpace*.10:tipY-staffSpace*.10-height;
    return {scale,x0:stemX-199*scale,y0:glyphTop+933*scale,
      centerX:stemX,top:glyphTop,bottom:glyphTop+height,width,height};
  }
  // Re-ink the original music-font outline rather than building substitute
  // tremolo bars. A narrow, same-color stroke around its filled contour gives
  // the printed-edition weight while retaining the glyph's original width.
  // Values here are screen pixels, not SVG font units.
  function tremoloInkBoostPx(staffSpace){
    return finite(staffSpace)&&staffSpace>0
      ?Math.min(3.2,Math.max(1.55,staffSpace*.195)):null;
  }
  // A compact rightward nudge for the two m62 sharps, not its B natural.
  function m62SharpNudgePx(staffSpace){
    return finite(staffSpace)&&staffSpace>0
      ?Math.min(3.0,Math.max(1.45,staffSpace*.19)):null;
  }
  root.PianoLayoutGeometry=Object.freeze({interpolateShift,beamAssignment,beamAssignment32,
    warpPolygonPoints,readPolygon,drawPolygon,openingClearance,threeStrokeGlyphPose,
    tremoloInkBoostPx,m62SharpNudgePx});
  if(typeof module==='object'&&module.exports)module.exports=root.PianoLayoutGeometry;
})(typeof globalThis==='object'?globalThis:this);
