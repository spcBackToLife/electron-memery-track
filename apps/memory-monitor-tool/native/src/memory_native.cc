// memory_native.cc - Windows native memory info addon for Electron Memory Monitor Tool
//
// Uses Win32 API to get process memory details directly (Private Working Set).
// Exports:
//   - getProcessMemoryDetails(pid)
//   - getPrivateWorkingSet(pid)
//   - batchGetPrivateWorkingSet(pids[])
//   - batchGetProcessMemory(pids[])
//
// Built with N-API (node-addon-api) for ABI stability.

#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#pragma comment(lib, "psapi.lib")
#endif

#ifdef _WIN32

static int64_t GetPrivateWorkingSetBytes(DWORD pid) {
  HANDLE hProcess = OpenProcess(
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
    FALSE,
    pid
  );
  if (!hProcess) return -1;

  int64_t privateWsBytes = 0;
  MEMORY_BASIC_INFORMATION mbi;
  LPBYTE addr = 0;
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  DWORD pageSize = si.dwPageSize;

  const size_t BATCH_SIZE = 4096;
  PSAPI_WORKING_SET_EX_INFORMATION* wsInfo =
    (PSAPI_WORKING_SET_EX_INFORMATION*)malloc(sizeof(PSAPI_WORKING_SET_EX_INFORMATION) * BATCH_SIZE);

  if (!wsInfo) { CloseHandle(hProcess); return -1; }

  while (addr < (LPBYTE)si.lpMaximumApplicationAddress) {
    SIZE_T result = VirtualQueryEx(hProcess, addr, &mbi, sizeof(mbi));
    if (result == 0) { addr += pageSize; continue; }

    if (mbi.State == MEM_COMMIT) {
      SIZE_T regionSize = mbi.RegionSize;
      LPBYTE regionBase = (LPBYTE)mbi.BaseAddress;
      SIZE_T numPages = regionSize / pageSize;

      for (SIZE_T offset = 0; offset < numPages; offset += BATCH_SIZE) {
        SIZE_T batchCount = min(BATCH_SIZE, numPages - offset);
        for (SIZE_T i = 0; i < batchCount; i++) {
          wsInfo[i].VirtualAddress = regionBase + (offset + i) * pageSize;
        }
        if (QueryWorkingSetEx(hProcess, wsInfo,
              (DWORD)(batchCount * sizeof(PSAPI_WORKING_SET_EX_INFORMATION)))) {
          for (SIZE_T i = 0; i < batchCount; i++) {
            if (wsInfo[i].VirtualAttributes.Valid && !wsInfo[i].VirtualAttributes.Shared) {
              privateWsBytes += pageSize;
            }
          }
        }
      }
    }
    addr = (LPBYTE)mbi.BaseAddress + mbi.RegionSize;
  }

  free(wsInfo);
  CloseHandle(hProcess);
  return privateWsBytes;
}

static bool GetProcessMemoryDetails(DWORD pid,
    SIZE_T& outWorkingSetSize,
    SIZE_T& outPeakWorkingSetSize,
    SIZE_T& outPrivateUsage,
    SIZE_T& outPagefileUsage) {
  HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
  if (!hProcess) return false;

  PROCESS_MEMORY_COUNTERS_EX pmc;
  pmc.cb = sizeof(pmc);
  BOOL ok = GetProcessMemoryInfo(hProcess, (PROCESS_MEMORY_COUNTERS*)&pmc, sizeof(pmc));
  CloseHandle(hProcess);
  if (!ok) return false;

  outWorkingSetSize = pmc.WorkingSetSize;
  outPeakWorkingSetSize = pmc.PeakWorkingSetSize;
  outPrivateUsage = pmc.PrivateUsage;
  outPagefileUsage = pmc.PagefileUsage;
  return true;
}

#endif // _WIN32

Napi::Value GetProcessMemoryDetailsNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected pid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }

  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  SIZE_T ws, peakWs, privateUsage, pagefileUsage;
  if (!GetProcessMemoryDetails(pid, ws, peakWs, privateUsage, pagefileUsage)) return env.Null();

  auto result = Napi::Object::New(env);
  result.Set("workingSetSize", Napi::Number::New(env, (double)ws));
  result.Set("peakWorkingSetSize", Napi::Number::New(env, (double)peakWs));
  result.Set("privateUsage", Napi::Number::New(env, (double)privateUsage));
  result.Set("pagefileUsage", Napi::Number::New(env, (double)pagefileUsage));
  return result;
#else
  return env.Null();
#endif
}

Napi::Value GetPrivateWorkingSetNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected pid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }
  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  int64_t bytes = GetPrivateWorkingSetBytes(pid);
  return Napi::Number::New(env, (double)bytes);
#else
  return Napi::Number::New(env, -1.0);
#endif
}

Napi::Value BatchGetPrivateWorkingSetNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Object::New(env);

#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return result;
  }

  Napi::Array pids = info[0].As<Napi::Array>();
  uint32_t len = pids.Length();

  for (uint32_t i = 0; i < len; i++) {
    Napi::Value val = pids[i];
    if (!val.IsNumber()) continue;
    DWORD pid = val.As<Napi::Number>().Uint32Value();
    int64_t bytes = GetPrivateWorkingSetBytes(pid);
    if (bytes >= 0) result.Set(std::to_string(pid), Napi::Number::New(env, (double)bytes));
  }
#endif

  return result;
}

Napi::Value BatchGetProcessMemoryNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Object::New(env);

#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return result;
  }

  Napi::Array pids = info[0].As<Napi::Array>();
  uint32_t len = pids.Length();

  for (uint32_t i = 0; i < len; i++) {
    Napi::Value val = pids[i];
    if (!val.IsNumber()) continue;
    DWORD pid = val.As<Napi::Number>().Uint32Value();
    SIZE_T ws, peakWs, privateUsage, pagefileUsage;
    if (GetProcessMemoryDetails(pid, ws, peakWs, privateUsage, pagefileUsage)) {
      auto obj = Napi::Object::New(env);
      obj.Set("workingSetSize", Napi::Number::New(env, (double)ws));
      obj.Set("peakWorkingSetSize", Napi::Number::New(env, (double)peakWs));
      obj.Set("privateUsage", Napi::Number::New(env, (double)privateUsage));
      obj.Set("pagefileUsage", Napi::Number::New(env, (double)pagefileUsage));
      result.Set(std::to_string(pid), obj);
    }
  }
#endif

  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getProcessMemoryDetails", Napi::Function::New(env, GetProcessMemoryDetailsNapi));
  exports.Set("getPrivateWorkingSet", Napi::Function::New(env, GetPrivateWorkingSetNapi));
  exports.Set("batchGetPrivateWorkingSet", Napi::Function::New(env, BatchGetPrivateWorkingSetNapi));
  exports.Set("batchGetProcessMemory", Napi::Function::New(env, BatchGetProcessMemoryNapi));
  return exports;
}

NODE_API_MODULE(memory_native, Init)
