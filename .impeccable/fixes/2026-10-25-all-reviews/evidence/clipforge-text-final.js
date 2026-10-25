async page => {
 await page.reload(); await page.getByRole('button',{name:'Library',exact:true}).first().click();await page.locator('.card').first().click();await page.getByRole('slider',{name:'Trim start',exact:true}).waitFor();
 const results=[];
 for(const [width,height] of [[1280,800],[960,620]]) {
  await page.setViewportSize({width,height});
  await page.locator('.editor-title').evaluate(el=>el.textContent='Valorant — A very long custom clip title with several moments and teammates celebrating the final round '.repeat(4));
  const b=await page.locator('.editor').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));if(b.scroll>b.width+2)throw new Error('Long title overflow');
  const css=await page.addStyleTag({content:':root{--text-xs:24px;--text-sm:26px;--text-md:28px;--text-lg:32px;--text-heading:36px;--text-title:56px}'});
  const dimensions=await page.locator('.editor').evaluate(e=>({width:e.clientWidth,scrollWidth:e.scrollWidth,height:e.clientHeight,scrollHeight:e.scrollHeight}));
  results.push({width,height,dimensions});
  const action=page.getByRole('button',{name:'Export and copy',exact:true});await action.scrollIntoViewIfNeeded(); if(!await action.isVisible())throw new Error('Enlarged export unreachable');
  await page.getByRole('slider',{name:'Trim start',exact:true}).focus();await page.keyboard.press('ArrowRight');
  await page.screenshot({path:`C:/Users/Spoon/AppData/Local/Temp/editor-enlarged-${width}.png`});
  await css.evaluate(e=>e.remove());
 }
 await page.evaluate(data=>window.__textResults=data,results);
}
