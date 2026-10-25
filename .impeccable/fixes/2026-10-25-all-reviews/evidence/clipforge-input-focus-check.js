async page => {
  await page.getByRole('button',{name:'Library',exact:true}).first().click();
  await page.locator('.card-menu').first().focus(); await page.keyboard.press('Enter');
  await page.getByRole('dialog',{name:'Clip actions',exact:true}).getByRole('button',{name:'Copy file — paste in Discord',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('card-menu'));
  await page.getByRole('button',{name:'Settings',exact:true}).click(); await page.locator('.settings-index').getByText('Audio & games',{exact:true}).click(); await page.getByRole('link',{name:'Games',exact:true}).click();
  const field=page.getByRole('textbox',{name:'Watched game executables, one per line',exact:true});
  const before=await field.inputValue(); await field.focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter'); await page.keyboard.type('newgame.exe');
  if(await field.inputValue() !== before+'\nnewgame.exe') throw new Error('Watched draft still normalizes during editing');
  await page.keyboard.press('Tab');
}
