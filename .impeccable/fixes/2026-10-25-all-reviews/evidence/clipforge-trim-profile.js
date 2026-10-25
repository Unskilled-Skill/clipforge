async page => {
 await page.getByRole('button',{name:'Library',exact:true}).first().click(); await page.locator('.card').first().click();
 await page.getByRole('slider',{name:'Trim start',exact:true}).waitFor();
 const video=page.locator('.player-wrap video'); await video.evaluate(el=>el.pause());
 const cdp=await page.context().newCDPSession(page); await cdp.send('Performance.enable');
 const read=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 const h=await page.locator('.mt-handle.start').boundingBox(); await page.mouse.move(h.x+6,h.y+30); await page.mouse.down();
 const before=await read(); await page.mouse.move(h.x+140,h.y+30,{steps:40}); const after=await read(); await page.mouse.up();
 const data={layoutCount:after.LayoutCount-before.LayoutCount,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,styleMs:(after.RecalcStyleDuration-before.RecalcStyleDuration)*1000,taskMs:(after.TaskDuration-before.TaskDuration)*1000};
 await page.evaluate(data=>{window.__trimProfile=data;},data); await cdp.detach();
}
