async page => {
 await page.setViewportSize({width:960,height:620});
 const checks=[];
 const start=page.getByRole('slider',{name:'Trim start',exact:true});
 await page.locator('.player-wrap video').evaluate(v=>v.pause());
 for(const zoom of [false,true]) {
   if(zoom) await page.getByRole('button',{name:'Zoom in',exact:true}).click();
   await start.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
   await page.waitForTimeout(80);
   const geometry=await page.evaluate(()=>{const box=s=>document.querySelector(s).getBoundingClientRect(); const range=box('.mt-range'),a=box('.mt-handle.start'),b=box('.mt-handle.end');return {range:{left:range.left,right:range.right},start:a.left,end:b.right};});
   if(Math.abs(geometry.range.left-geometry.start)>1 || Math.abs(geometry.range.right-geometry.end)>1) throw new Error('Trim geometry '+JSON.stringify(geometry));
   checks.push({zoom,geometry});
 }
 const mixer=page.getByRole('button',{name:/^Audio ·/}); if(await mixer.getAttribute('aria-expanded')!=='true') await mixer.click();
 await page.getByRole('checkbox',{name:'Include mic in export',exact:true}).check(); await page.getByRole('slider',{name:'mic export volume',exact:true}).focus();
 await page.keyboard.press('ArrowLeft');
 if(await page.locator('.editor').evaluate(e=>e.scrollTop)!==0) throw new Error('Mixer keyboard scrolled workspace');
 const mic=await page.getByRole('slider',{name:'mic export volume',exact:true}).boundingBox();
 if(mic.y<0 || mic.y+mic.height>620) throw new Error('Mic not reachable');
 await page.getByText('More ways to share',{exact:true}).click();
 await page.locator('.export-panel').evaluate(e=>e.scrollTop=e.scrollHeight);
 const editor=await page.locator('.editor').evaluate(e=>({height:e.clientHeight,scroll:e.scrollHeight,width:e.clientWidth,scrollWidth:e.scrollWidth}));
 if(editor.scroll>editor.height+2||editor.scrollWidth>editor.width+2) throw new Error('Share expands workspace');
 await page.getByText('More ways to share',{exact:true}).click();
 await page.evaluate(data=>window.__deepLayout=data,{checks,mic,editor});
}
