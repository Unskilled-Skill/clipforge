//! Microphones and speakers for Settings › Split audio. Ids are WASAPI
//! endpoint ids, the same ones the capture engine's audio sources take.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Default, Debug)]
pub struct AudioDevices {
    pub inputs: Vec<AudioDevice>,
    pub outputs: Vec<AudioDevice>,
}

fn endpoints(flow: windows::Win32::Media::Audio::EDataFlow) -> windows::core::Result<Vec<AudioDevice>> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};

    unsafe {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let collection = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?;
        let mut devices = Vec::new();
        for i in 0..collection.GetCount()? {
            let device = collection.Item(i)?;
            let raw_id = device.GetId()?;
            let id = raw_id.to_string().unwrap_or_default();
            CoTaskMemFree(Some(raw_id.0 as *const _));
            let name = device
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .map(|value| value.to_string())
                .unwrap_or_else(|_| id.clone());
            devices.push(AudioDevice { id, name });
        }
        devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(devices)
    }
}

/// Active microphones (inputs) and speakers/headsets (outputs).
#[tauri::command]
pub async fn list_audio_devices() -> Result<AudioDevices, String> {
    crate::clips::blocking(|| {
        use windows::Win32::Media::Audio::{eCapture, eRender};
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
        unsafe {
            let initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let result = (|| -> windows::core::Result<AudioDevices> {
                Ok(AudioDevices { inputs: endpoints(eCapture)?, outputs: endpoints(eRender)? })
            })();
            if initialized {
                CoUninitialize();
            }
            result.map_err(|e| format!("Could not list audio devices: {e}"))
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn lists_devices_without_failing() {
        // Machines without audio hardware just return empty lists.
        let devices = tauri::async_runtime::block_on(super::list_audio_devices()).unwrap();
        for d in devices.inputs.iter().chain(&devices.outputs) {
            assert!(!d.id.is_empty());
            assert!(!d.name.is_empty());
        }
    }
}
