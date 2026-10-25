async page => {
 await page.reload(); await page.getByRole('button',{name:'Library',exact:true}).first().click();
 await page.locator('.card-select').nth(0).click(); await page.locator('.card-select').nth(1).click(); await page.locator('.card-select').nth(2).click();
 const before=await page.locator('.sel-strip-entry').evaluateAll(nodes=>nodes.map(el=>el.dataset.selectionPath));
 await page.getByRole('button',{name:'Move clip 2 earlier',exact:true}).click();
 const after=await page.locator('.sel-strip-entry').evaluateAll(nodes=>nodes.map(el=>el.dataset.selectionPath));
 if(after[0]!==before[1] || after[1]!==before[0]) throw new Error('Move earlier failed');
 await page.locator('.sel-strip-entry').first().focus(); await page.keyboard.press('Control+ArrowRight');
 await page.waitForFunction(first=>document.querySelector('.sel-strip-entry')?.getAttribute('data-selection-path')===first,before[0]);
 await page.getByRole('button',{name:'Clear',exact:true}).click(); await page.locator('.card').first().click();
 if(await page.getByRole('heading',{level:1}).count()!==1) throw new Error('Editor page heading missing');
 if(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)!=='dark') throw new Error('Native dark theme missing');
 const skip=page.getByRole('link',{name:'Skip to main content',exact:true}); await skip.focus(); await page.keyboard.press('Enter');
 if(!(await page.locator('main').evaluate(el=>el===document.activeElement))) throw new Error('Skip link failed');
}
