async page => {
  const settings=page.getByRole('button',{name:'Settings',exact:true}); await settings.focus(); await page.keyboard.down('Space'); await page.waitForTimeout(150);
  if(await settings.evaluate(el=>getComputedStyle(el).transform) !== 'none') throw new Error('Keyboard press still scales'); await page.keyboard.up('Space');
  if(await page.locator('.settings-body').evaluate(el=>el.getAnimations({subtree:true}).some(a=>a.animationName==='cf-rise'))) throw new Error('Settings entrance still animates');
  await page.emulateMedia({reducedMotion:'reduce'});
  const knob=page.locator('.switch .knob').first(); if(await knob.evaluate(el=>getComputedStyle(el).transitionDuration) !== '0s') throw new Error('Knob still animates under reduce');
  await page.getByRole('button',{name:'Library',exact:true}).first().click(); await page.locator('.card-thumb').first().hover(); await page.waitForTimeout(350);
  if(await page.locator('.thumb-preview').count()) throw new Error('Reduced motion still mounts hover preview');
  if(await page.locator('.card').first().evaluate(el=>getComputedStyle(el,'::before').transform) !== 'none') throw new Error('Reduced edge still moves');
  await page.locator('.card-menu').first().click(); if(await page.locator('.ctx-menu').evaluate(el=>el.getAnimations().some(a=>a.animationName==='cf-rise'))) throw new Error('Menu entrance still animates');
  await page.keyboard.press('Escape'); await page.emulateMedia({reducedMotion:'no-preference'});
}
