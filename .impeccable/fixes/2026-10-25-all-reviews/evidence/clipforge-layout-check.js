async page => {
  await page.reload(); const skip=page.getByRole('button',{name:'Skip tutorial',exact:true}); if(await skip.isVisible()) await skip.click();
  await page.locator('.card').first().click(); await page.getByRole('slider',{name:'Trim start',exact:true}).waitFor();
  const results=[];
  for(const [width,height] of [[1280,800],[960,620],[1440,900]]) {
    await page.setViewportSize({width,height});
    for(const open of [false,true]) {
      const toggle=page.getByRole('button',{name:/^Audio ·/}); if((await toggle.getAttribute('aria-expanded')) !== String(open)) await toggle.click();
      const bounds=await page.locator('.editor').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,width:el.clientWidth,scrollWidth:el.scrollWidth}));
      const player=await page.locator('.player-wrap video').boundingBox();
      const trim=await page.locator('.trim-section').boundingBox();
      results.push({width,height,open,bounds,player,trim});
      if(bounds.scroll > bounds.height+2 || bounds.scrollWidth>bounds.width+2 || trim.y+trim.height>height) throw new Error(JSON.stringify(results));
      if(player.width<380 || player.height<200) throw new Error(`Preview too small ${JSON.stringify(results)}`);
      await page.screenshot({path:`C:/Users/Spoon/AppData/Local/Temp/editor-fix-${width}-${open}.png`});
    }
  }
  await page.evaluate(data=>{window.__layoutResults=data;},results);
}
