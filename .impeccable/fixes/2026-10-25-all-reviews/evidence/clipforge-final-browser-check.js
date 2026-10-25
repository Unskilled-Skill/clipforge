async page => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({width:1000,height:900});
  const skip = page.getByRole('button', {name:'Skip tutorial', exact:true});
  if (await skip.isVisible()) await skip.click();
  await page.getByRole('button', {name:'Settings', exact:true}).click();
  await page.getByText('Show 10 healthy checks', {exact:true}).waitFor();
  if ((await page.locator('#settings-capture').boundingBox()).y > 700) throw new Error('Capture buried');
  await page.getByRole('link', {name:'Hotkeys', exact:true}).click();
  const hotkey = page.locator('.hotkey-capture').first(); await hotkey.focus(); await page.keyboard.press('Tab');
  if (await hotkey.evaluate(el => el === document.activeElement)) throw new Error('Hotkey traps Tab');
  await page.getByRole('link', {name:'Storage', exact:true}).click();
  await page.getByRole('textbox', {name:'Back up starred clips to', exact:true}).waitFor();
  await page.getByRole('button', {name:'Tutorial', exact:true}).click();
  const tutorial = page.getByRole('dialog', {name:'ClipForge tutorial', exact:true});
  await tutorial.getByRole('button', {name:'Next', exact:true}).focus(); await page.keyboard.press('Tab');
  if (!(await tutorial.getByRole('button', {name:'Close', exact:true}).evaluate(el => el === document.activeElement))) throw new Error('Modal focus escaped');
  await page.keyboard.press('Escape');
  await page.getByRole('link', {name:'Health', exact:true}).click();
  await page.screenshot({path:'C:/Users/Spoon/AppData/Local/Temp/clipforge-settings-final-1000.png'});
  await page.getByRole('button', {name:'Library', exact:true}).first().click();
  const search = page.getByRole('textbox', {name:'Search clips…', exact:true});
  await search.fill('siege'); if (await page.locator('.card').count() !== 3) throw new Error('Friendly search failed');
  await search.fill(''); await page.locator('.card').first().click();
  await page.getByRole('checkbox', {name:'Include game in export', exact:true}).check();
  await page.getByText(/mix removed to avoid duplicate sound/).waitFor();
  if (await page.getByRole('checkbox', {name:'Include mix in export', exact:true}).isChecked()) throw new Error('Overlap guard failed');
  await page.getByRole('button', {name:/^Rename Valorant/}).focus(); await page.keyboard.press('Enter');
  await page.locator('.rename-input').waitFor(); await page.keyboard.press('Escape');
  for (const width of [1440,1000]) {
    await page.setViewportSize({width,height:900});
    const fit = await page.locator('.editor').evaluate(el => ({height:el.clientHeight,content:el.scrollHeight}));
    if (fit.content > fit.height + 2) throw new Error(`${width}: ${JSON.stringify(fit)}`);
    await page.screenshot({path:`C:/Users/Spoon/AppData/Local/Temp/clipforge-editor-final-${width}.png`});
  }
  await page.getByRole('button', {name:'Library', exact:true}).first().click();
  await page.evaluate(() => { Math.random = () => 0; window.confirm = message => { window.__confirmation = message; return false; }; });
  const count = await page.locator('.card').count();
  await page.getByRole('button', {name:'Find blank recordings', exact:true}).click();
  await page.getByRole('button', {name:/^Delete \d+ black$/}).click();
  if (!(await page.evaluate(() => window.__confirmation.includes('Recycle Bin')))) throw new Error('Missing confirmation');
  if (await page.locator('.card').count() !== count) throw new Error('Cancellation lost clips');
  await page.route('**/src/tauri-shim.ts*', async route => {
    const response = await route.fetch(); const body = await response.text();
    const pattern = /case "copy_clip":\s*return null;/;
    if (!pattern.test(body)) throw new Error('Failure injection setup did not match');
    await route.fulfill({response,body:body.replace(pattern, 'case "copy_clip": throw new Error("Permission denied in preview regression");')});
  });
  await page.reload();
  await page.locator('.card-quick-share').first().click();
  await page.getByRole('alert').getByText(/Could not copy this clip.*try Share again/).waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
}
