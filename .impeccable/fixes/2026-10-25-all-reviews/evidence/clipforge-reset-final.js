async page => { await page.route('**/src/tauri-shim.ts*', async route => { const response=await route.fetch(); let body=await response.text(); body=body.replace('case "save_settings":', 'case "save_settings": if(window.__failSettings) throw new Error("read-only test");'); await route.fulfill({response,body}); });
 await page.reload(); const skip=page.getByRole('button',{name:'Skip tutorial',exact:true});if(await skip.isVisible())await skip.click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.evaluate(()=>window.__failSettings=true);
 const toggle=page.getByRole('switch',{name:'Auto buffer',exact:true});const original=await toggle.getAttribute('aria-checked');
 await toggle.click();await page.getByText(/Could not save settings. Your edits are preserved/).waitFor();
 await page.evaluate(()=>window.__failSettings=false);
 await page.evaluate(()=>window.confirm=()=>true);await page.getByRole('button',{name:'Reset to defaults',exact:true}).click();
 await page.getByText('Settings reset to defaults',{exact:true}).waitFor();
 if(await page.getByRole('button',{name:'Retry saving',exact:true}).count())throw new Error('Reset retained retry');
 if(await toggle.getAttribute('aria-checked')!==original)throw new Error('Reset failed to restore default toggle');
 const next=page.getByRole('switch',{name:'Auto-clip kills',exact:true});await next.click();await page.getByText('Changes saved',{exact:true}).waitFor();
 if(await toggle.getAttribute('aria-checked')!==original)throw new Error('Next edit reapplied failed patch');
 await page.evaluate(()=>window.__resetCheck='passed');
}
