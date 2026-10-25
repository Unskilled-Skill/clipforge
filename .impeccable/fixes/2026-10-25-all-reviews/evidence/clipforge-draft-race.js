async page => {
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.locator('.settings-index').getByText('Audio & games',{exact:true}).click();await page.getByRole('link',{name:'Audio',exact:true}).click();
 await page.evaluate(()=>window.__saveDelay=900);
 await page.getByRole('switch',{name:'Mic noise suppression',exact:true}).click();
 const vc=page.getByRole('textbox',{name:'Voice-chat app (.exe)',exact:true});await vc.fill('draft-during-save.exe');
 await page.getByText('Changes saved',{exact:true}).waitFor();
 if(await vc.inputValue()!=='draft-during-save.exe')throw new Error('Pending save erased focused draft');
 await vc.press('Tab');await page.getByText('Changes saved',{exact:true}).waitFor();
 if(await vc.inputValue()!=='draft-during-save.exe')throw new Error('Blur failed after race');
 await page.evaluate(()=>{window.__draftRace='passed';window.__saveDelay=150;});
}
