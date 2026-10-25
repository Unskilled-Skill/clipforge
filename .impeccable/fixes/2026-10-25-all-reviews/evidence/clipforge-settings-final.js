async page => {
 const go=async(group,name)=>{const details=page.locator('.settings-nav-group').filter({has:page.locator('summary',{hasText:group})});if(!await details.evaluate(e=>e.open))await details.locator('summary').click();await page.getByRole('link',{name,exact:true}).click();};
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 for(const [width,height] of [[1280,800],[960,620]]) {
  await page.setViewportSize({width,height});
  if(await page.locator('.health-details').evaluate(e=>e.open))throw new Error('Healthy diagnostics open by default');
  for(const [group,name] of [['Capture','Recording quality'],['Capture','Automation'],['Capture','Hotkeys'],['Audio & games','Audio'],['Audio & games','Games'],['Audio & games','Advanced'],['Storage & sharing','Storage'],['Storage & sharing','Sharing'],['Health','Diagnostics']]) {
   await go(group,name); if(await page.evaluate(()=>document.activeElement.tagName)!=='H2') throw new Error('Destination heading not focused: '+name);
  }
 }
 await go('Audio & games','Audio');
 const vc=page.getByRole('textbox',{name:'Voice-chat app (.exe)',exact:true});await vc.fill('teams.exe');await vc.press('Tab');await page.getByText('Changes saved',{exact:true}).waitFor();
 if(await vc.inputValue()!=='teams.exe')throw new Error('VC blur lost edit');
 await go('Storage & sharing','Storage'); const folder=page.getByRole('textbox',{name:'Clips folder',exact:true});await folder.fill('D:/Clips Test');await folder.press('Tab');await page.getByText('Changes saved',{exact:true}).waitFor();
 if(await folder.inputValue()!=='D:/Clips Test')throw new Error('Folder blur lost edit');
 await page.getByRole('button',{name:'Library',exact:true}).first().click();await page.getByRole('button',{name:'Settings',exact:true}).click();await go('Audio & games','Audio');if(await vc.inputValue()!=='teams.exe')throw new Error('Saved VC not retained on return');
 await page.screenshot({path:'C:/Users/Spoon/AppData/Local/Temp/settings-final-960.png'});
}
