// memory_native.cc - Windows native memory info addon for Electron memory monitor
//
// Uses Win32 API to get process memory details directly, no external process needed.
// Exports:
//   - getProcessMemoryDetails(pid)
//   - getPrivateWorkingSet(pid)
//   - batchGetPrivateWorkingSet(pids[])
//   - batchGetProcessMemory(pids[])
//
// Built with N-API (node-addon-api) for ABI stability across Node.js/Electron versions.

#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#pragma comment(lib, "psapi.lib")
#endif

#ifdef _WIN32

// Calculate Private Working Set for a given PID (in bytes).
//
// Implementation: QueryWorkingSetEx approach.
//   1. Open the target process with PROCESS_QUERY_INFORMATION | PROCESS_VM_READ.
//   2. Use VirtualQueryEx to enumerate all MEM_COMMIT regions.
//   3. For each region, use QueryWorkingSetEx to check page attributes.
//   4. Count pages where Valid==true && Shared==false => Private Working Set.
//
// This matches what Windows Task Manager reports.
// Returns -1 on failure.
static int64_t GetPrivateWorkingSetBytes(DWORD pid) {
  HANDLE hProcess = OpenProcess(
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
    FALSE,
    pid
  );
  if (!hProcess) {
    return -1;
  }

  int64_t privateWsBytes = 0;
  MEMORY_BASIC_INFORMATION mbi;
  LPBYTE addr = 0;
  SYSTEM_INFO si;
  GetSystemInfo(&si);
  DWORD pageSize = si.dwPageSize;

  // Process pages in batches of 4096
  const size_t BATCH_SIZE = 4096;
  PSAPI_WORKING_SET_EX_INFORMATION* wsInfo =
    (PSAPI_WORKING_SET_EX_INFORMATION*)malloc(sizeof(PSAPI_WORKING_SET_EX_INFORMATION) * BATCH_SIZE);

  if (!wsInfo) {
    CloseHandle(hProcess);
    return -1;
  }

  while (addr < (LPBYTE)si.lpMaximumApplicationAddress) {
    SIZE_T result = VirtualQueryEx(hProcess, addr, &mbi, sizeof(mbi));
    if (result == 0) {
      // Skip invalid region
      addr += pageSize;
      continue;
    }

    // Only process committed memory regions
    if (mbi.State == MEM_COMMIT) {
      SIZE_T regionSize = mbi.RegionSize;
      LPBYTE regionBase = (LPBYTE)mbi.BaseAddress;
      SIZE_T numPages = regionSize / pageSize;

      // Query page attributes in batches
      for (SIZE_T offset = 0; offset < numPages; offset += BATCH_SIZE) {
        SIZE_T batchCount = min(BATCH_SIZE, numPages - offset);

        for (SIZE_T i = 0; i < batchCount; i++) {
          wsInfo[i].VirtualAddress = regionBase + (offset + i) * pageSize;
        }

        // Check if pages are resident and whether they are shared
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

// Fast approach: read PROCESS_MEMORY_COUNTERS_EX fields directly.
// Returns multiple memory counters for the given PID.
static bool GetProcessMemoryDetails(DWORD pid,
    SIZE_T& outWorkingSetSize,
    SIZE_T& outPeakWorkingSetSize,
    SIZE_T& outPrivateUsage,
    SIZE_T& outPagefileUsage) {
  HANDLE hProcess = OpenProcess(
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
    FALSE,
    pid
  );
  if (!hProcess) {
    return false;
  }

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

// --- N-API exports ---

// getProcessMemoryDetails(pid: number): object | null
// Returns { workingSetSize, peakWorkingSetSize, privateUsage, pagefileUsage } in bytes.
Napi::Value GetProcessMemoryDetailsNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected pid (number)").ThrowAsJavaScriptException();
    return env.Null();
  }

  DWORD pid = info[0].As<Napi::Number>().Uint32Value();
  SIZE_T ws, peakWs, privateUsage, pagefileUsage;

  if (!GetProcessMemoryDetails(pid, ws, peakWs, privateUsage, pagefileUsage)) {
    return env.Null();
  }

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

// getPrivateWorkingSet(pid: number): number
// Returns private working set in bytes, or -1 on failure.
// Note: this enumerates process pages and may take tens of ms for large processes.
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

// batchGetPrivateWorkingSet(pids: number[]): Record<string, number>
// Batch query private working set. Returns { "pid": bytes }.
// PIDs that cannot be queried are omitted from the result.
Napi::Value BatchGetPrivateWorkingSetNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Object::New(env);

#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Array pids = info[0].As<Napi::Array>();
  uint32_t len = pids.Length();

  for (uint32_t i = 0; i < len; i++) {
    Napi::Value val = pids[i];
    if (!val.IsNumber()) continue;

    DWORD pid = val.As<Napi::Number>().Uint32Value();
    int64_t bytes = GetPrivateWorkingSetBytes(pid);

    if (bytes >= 0) {
      result.Set(std::to_string(pid), Napi::Number::New(env, (double)bytes));
    }
  }
#endif

  return result;
}

// batchGetProcessMemory(pids: number[]): Record<string, object>
// Batch query process memory details (fast, no page enumeration).
// Returns { "pid": { workingSetSize, peakWorkingSetSize, privateUsage, pagefileUsage } }
Napi::Value BatchGetProcessMemoryNapi(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto result = Napi::Object::New(env);

#ifdef _WIN32
  if (info.Length() < 1 || !info[0].IsArray()) {
    Napi::TypeError::New(env, "Expected pids (number[])").ThrowAsJavaScriptException();
    return env.Null();
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

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getProcessMemoryDetails",
    Napi::Function::New(env, GetProcessMemoryDetailsNapi));
  exports.Set("getPrivateWorkingSet",
    Napi::Function::New(env, GetPrivateWorkingSetNapi));
  exports.Set("batchGetPrivateWorkingSet",
    Napi::Function::New(env, BatchGetPrivateWorkingSetNapi));
  exports.Set("batchGetProcessMemory",
    Napi::Function::New(env, BatchGetProcessMemoryNapi));
  return exports;
}

NODE_API_MODULE(memory_native, Init)
