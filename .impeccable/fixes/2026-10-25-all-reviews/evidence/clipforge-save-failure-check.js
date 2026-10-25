async page => {
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/src/tauri-shim.ts*',async route=>{
    const response=await route.fetch(); let body=await response.text();
    if(!body.includes('case "load_settings":')) throw new Error('Save failure injection did not match');
    body=body.replace('case "save_settings":','case "save_settings": await new Promise(resolve => setTimeout(resolve, window.__saveDelay ?? 150)); if(window.__failSettings) throw new Error("Disk is read-only (test)");');
    body=body.replace('case "backup_now":','case "backup_now": if(window.__failBackup) throw new Error("Backup drive missing (test)");');
    await route.fulfill({response,body});
  });
  await page.reload(); const skip=page.getByRole('button',{name:'Skip tutorial',exact:true}); if(await skip.isVisible()) await skip.click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.evaluate(()=>{window.__failSettings=true;});
  const toggle=page.getByRole('switch',{name:'Auto buffer',exact:true}); const before=await toggle.getAttribute('aria-checked');
  await toggle.click(); await page.getByText('Saving settings…',{exact:true}).waitFor();
  await page.getByText(/Could not save settings. Your edits are preserved/).waitFor();
  if(await toggle.getAttribute('aria-checked')===before) throw new Error('Failed save lost edited value');
  await page.evaluate(()=>{window.__failSettings=false;}); await page.getByRole('button',{name:'Retry saving',exact:true}).click();
  await page.getByText('Changes saved',{exact:true}).waitFor();
  await page.locator('.settings-index').getByText('Storage & sharing',{exact:true}).click(); await page.getByRole('link',{name:'Storage',exact:true}).click(); await page.evaluate(()=>{window.__failBackup=true;});
  await page.getByRole('button',{name:'Back up now',exact:true}).click();
  await page.getByRole('alert').getByText(/Could not back up your clips/).waitFor();
  if(errors.length) throw new Error(errors.join('\n'));
}
