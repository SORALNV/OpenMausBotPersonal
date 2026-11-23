// Verifies one owner-private file or directory through a held Win32 handle: the path is
// never dereferenced through a reparse point, the owner must be this process token's user,
// and every access allowed must belong to that user under a protected DACL. This is what
// Windows has instead of the POSIX mode/uid checks the server's guards expect.
#include <windows.h>
#include <aclapi.h>
#include <node_api.h>

#include <string>
#include <vector>
#include <cstring>

namespace {

// A user SID and, for an elevated token, the Administrators group: Windows gives an
// elevated process's plain creations the latter as owner, so both count as "owned by us".
struct TokenSids { PSID user = nullptr; PSID owner = nullptr; };

const TokenSids& tokenSids() {
  static TokenSids cached;
  if (cached.user != nullptr) return cached;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return cached;
  for (const TOKEN_INFORMATION_CLASS which : { TokenUser, TokenOwner }) {
    DWORD size = 0;
    GetTokenInformation(token, which, nullptr, 0, &size);
    if (size == 0) continue;
    std::vector<BYTE> buffer(size);
    if (!GetTokenInformation(token, which, buffer.data(), size, &size)) continue;
    auto* granted = reinterpret_cast<TOKEN_USER*>(buffer.data());
    const DWORD length = GetLengthSid(granted->User.Sid);
    PSID copy = LocalAlloc(LMEM_FIXED, length);
    if (copy == nullptr || !CopySid(length, copy, granted->User.Sid)) { LocalFree(copy); continue; }
    if (which == TokenUser) cached.user = copy;
    else cached.owner = copy;
  }
  CloseHandle(token);
  return cached;
}

// An object whose owner is either SID of this token belongs to this process's trust boundary.
bool ownedByUs(PSID owner) {
  const TokenSids& ours = tokenSids();
  if (owner == nullptr || ours.user == nullptr) return false;
  return EqualSid(owner, ours.user) || (ours.owner != nullptr && EqualSid(owner, ours.owner));
}

// Opens the path itself: a reparse point is reported, never followed.
HANDLE openAsWritten(const std::wstring& path, bool reparse) {
  DWORD flags = FILE_FLAG_BACKUP_SEMANTICS | (reparse ? FILE_FLAG_OPEN_REPARSE_POINT : 0);
  return CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, flags, nullptr);
}

napi_value verifyPrivate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_valuetype type = napi_undefined;
  napi_typeof(env, argv[1], &type);
  if (type != napi_object) {
    napi_throw_type_error(env, nullptr, "want must be an object");
    return nullptr;
  }
  size_t length = 0;
  napi_get_value_string_utf16(env, argv[0], nullptr, 0, &length);
  std::vector<char16_t> raw(length + 1);
  napi_get_value_string_utf16(env, argv[0], reinterpret_cast<char16_t*>(raw.data()), raw.size(), &length);
  std::wstring path(reinterpret_cast<const wchar_t*>(raw.data()));

  napi_value wanted = nullptr;
  bool hasKind = false, hasOwner = false, hasSingleLink = false, hasMaxBytes = false;
  napi_has_named_property(env, argv[1], "kind", &hasKind);
  napi_has_named_property(env, argv[1], "owner", &hasOwner);
  napi_has_named_property(env, argv[1], "singleLink", &hasSingleLink);
  napi_has_named_property(env, argv[1], "maxBytes", &hasMaxBytes);
  std::string kind;   // "", "file", "directory"
  bool owner = false, singleLink = false;
  double maxBytes = -1;
  if (hasKind) {
    size_t kindLength = 0;
    napi_get_named_property(env, argv[1], "kind", &wanted);
    napi_get_value_string_utf8(env, wanted, nullptr, 0, &kindLength);
    std::vector<char> kindBuffer(kindLength + 1);
    napi_get_value_string_utf8(env, wanted, kindBuffer.data(), kindBuffer.size(), &kindLength);
    kind.assign(kindBuffer.data(), kindLength);
  }
  if (hasOwner) { napi_get_named_property(env, argv[1], "owner", &wanted); napi_get_value_bool(env, wanted, &owner); }
  if (hasSingleLink) { napi_get_named_property(env, argv[1], "singleLink", &wanted); napi_get_value_bool(env, wanted, &singleLink); }
  if (hasMaxBytes) { napi_get_named_property(env, argv[1], "maxBytes", &wanted); napi_get_value_double(env, wanted, &maxBytes); }

  const char* rejection = nullptr;
  HANDLE held = openAsWritten(path, true);
  if (held == INVALID_HANDLE_VALUE) {
   DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) rejection = "missing";
    else rejection = "unavailable";
  } else {
    FILE_ATTRIBUTE_TAG_INFO tag = {};
    if (!GetFileInformationByHandleEx(held, FileAttributeTagInfo, &tag, sizeof(tag))) rejection = "unavailable";
    else if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) rejection = "symlink";
    CloseHandle(held);
    if (rejection == nullptr) {
      held = openAsWritten(path, false);
      if (held == INVALID_HANDLE_VALUE) rejection = "unavailable";
      else {
        BY_HANDLE_FILE_INFORMATION about = {};
        if (!GetFileInformationByHandle(held, &about)) rejection = "unavailable";
        else {
          const bool isDirectory = (about.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
          if (!kind.empty() && ((kind == "directory") != isDirectory)) rejection = "kind";
          else if (singleLink && about.nNumberOfLinks != 1) rejection = "links";
          else if (maxBytes >= 0) {
            ULARGE_INTEGER bytes = { { about.nFileSizeLow, about.nFileSizeHigh } };
            if (bytes.QuadPart > maxBytes) rejection = "size";
          }
          if (rejection == nullptr) {
            PSID ownerSid = nullptr, group = nullptr;
            PACL dacl = nullptr;
            PSECURITY_DESCRIPTOR descriptor = nullptr;
            if (GetSecurityInfo(held, SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &ownerSid, &group, &dacl, nullptr, &descriptor) != ERROR_SUCCESS) rejection = "unavailable";
            else {
              SECURITY_DESCRIPTOR_CONTROL control = 0;
              DWORD revision = 0;
              BOOL daclPresent = FALSE, daclDefaulted = FALSE;
              if (!ownedByUs(ownerSid)) rejection = "owner";
              else if (!GetSecurityDescriptorControl(descriptor, &control, &revision) || (control & SE_DACL_PRESENT) == 0 || (control & SE_DACL_PROTECTED) == 0) rejection = "mode";
              else if (!GetSecurityDescriptorDacl(descriptor, &daclPresent, &dacl, &daclDefaulted) || !daclPresent) rejection = "mode";
              else {
                for (USHORT at = 0; rejection == nullptr && at < dacl->AceCount; at++) {
                  LPVOID ace = nullptr;
                  if (!GetAce(dacl, at, &ace)) { rejection = "unavailable"; break; }
                  auto* header = reinterpret_cast<ACE_HEADER*>(ace);
                  // A record that is not the owner's own allow grant fails the check, deny or audit alike.
                  // The allow ACE carries its SID inline at SidStart, not in a Trustee field.
                  if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || !EqualSid(reinterpret_cast<PSID>(&reinterpret_cast<ACCESS_ALLOWED_ACE*>(ace)->SidStart), ownerSid)) rejection = "mode";
                }
              }
              if (descriptor != nullptr) LocalFree(descriptor);
            }
          }
        }
        CloseHandle(held);
      }
    }
  }

  napi_value result, ok;
  napi_create_object(env, &result);
  napi_get_boolean(env, rejection == nullptr, &ok);
  napi_set_named_property(env, result, "ok", ok);
  if (rejection != nullptr) {
    napi_value named;
    napi_create_string_utf8(env, rejection, NAPI_AUTO_LENGTH, &named);
    napi_set_named_property(env, result, "rejection", named);
  }
  return result;
}

// A security descriptor whose only grant is this user's full access, protected from inheritance:
// what a created POSIX 0700 directory or 0600 file means on Windows.
bool ownerOnlyDescriptor(PSECURITY_DESCRIPTOR descriptor, PACL* acl, PSID user, DWORD aceBytes) {
  if (!InitializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION)) return false;
  *acl = static_cast<PACL>(LocalAlloc(LMEM_FIXED, aceBytes));
  if (*acl == nullptr) return false;
  if (!InitializeAcl(*acl, aceBytes, ACL_REVISION) ||
      !AddAccessAllowedAceEx(*acl, ACL_REVISION, 0, FILE_ALL_ACCESS, user) ||
      !SetSecurityDescriptorOwner(descriptor, user, FALSE) ||
      !SetSecurityDescriptorDacl(descriptor, TRUE, *acl, FALSE) ||
      !SetSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    LocalFree(*acl);
    *acl = nullptr;
    return false;
  }
  return true;
}

napi_value createPrivate(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_valuetype type = napi_undefined;
  napi_typeof(env, argv[1], &type);
  if (type != napi_string) {
    napi_throw_type_error(env, nullptr, "kind must be a string");
    return nullptr;
  }
  size_t length = 0;
  napi_get_value_string_utf16(env, argv[0], nullptr, 0, &length);
  std::vector<char16_t> raw(length + 1);
  napi_get_value_string_utf16(env, argv[0], reinterpret_cast<char16_t*>(raw.data()), raw.size(), &length);
  std::wstring path(reinterpret_cast<const wchar_t*>(raw.data()));
  size_t kindLength = 0;
  napi_get_value_string_utf8(env, argv[1], nullptr, 0, &kindLength);
  std::vector<char> kindBuffer(kindLength + 1);
  napi_get_value_string_utf8(env, argv[1], kindBuffer.data(), kindBuffer.size(), &kindLength);
  std::string kind(kindBuffer.data(), kindLength);
  size_t contentLength = 0;
  bool binary = false;
  void* contentBytes = nullptr;
  bool isBuffer = false;
  if (napi_is_buffer(env, argv[2], &isBuffer) == napi_ok && isBuffer) {
    size_t bufferLength = 0;
    napi_get_buffer_info(env, argv[2], &contentBytes, &bufferLength);
    contentLength = bufferLength;
  } else {
    napi_get_value_string_utf8(env, argv[2], nullptr, 0, &contentLength);
  }
  // The reported utf8 length excludes the terminator the copy writes.
  std::vector<char> content(contentLength + 1);
  if (binary) std::memcpy(content.data(), contentBytes, contentLength);
  else napi_get_value_string_utf8(env, argv[2], content.data(), content.size(), &contentLength);

  const PSID user = tokenSids().user;
  const char* failure = nullptr;
  if (user == nullptr) failure = "unavailable";
  else {
    SECURITY_DESCRIPTOR descriptor;
    PACL acl = nullptr;
    const DWORD aceBytes = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(user) + sizeof(DWORD) * 2;
    SECURITY_ATTRIBUTES attributes = { sizeof(attributes), nullptr, FALSE };
    if (!ownerOnlyDescriptor(&descriptor, &acl, user, aceBytes)) failure = "unavailable";
    else {
      attributes.lpSecurityDescriptor = &descriptor;
      // The driver of a save: every separator names an ancestor directory, created
      // privately before the leaf; the leaf itself is made last, after them.
      for (size_t at = path.find(L'\\', 3); at != std::wstring::npos && failure == nullptr; at = path.find(L'\\', at + 1)) {
        const std::wstring prefix = path.substr(0, at);
        if (CreateDirectoryW(prefix.c_str(), &attributes) == 0 && GetLastError() != ERROR_ALREADY_EXISTS) failure = "cannot create directory";
      }
      if (failure == nullptr && kind == "file") {
        HANDLE created = CreateFileW(path.c_str(), GENERIC_WRITE, 0, &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (created == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_EXISTS) {
          // A save over an existing file: the content stays, the owner-only descriptor is forced onto it.
          if (SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
              OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, user, nullptr, acl, nullptr) != ERROR_SUCCESS) failure = "cannot privatize existing file";
        } else if (created == INVALID_HANDLE_VALUE) failure = "cannot create file";
        else {
          DWORD written = 0;
          if (!WriteFile(created, content.data(), static_cast<DWORD>(contentLength), &written, nullptr) || written != contentLength) failure = "cannot write file";
          CloseHandle(created);
        }
      } else if (failure == nullptr) {
        if (CreateDirectoryW(path.c_str(), &attributes) == 0) {
          if (GetLastError() == ERROR_ALREADY_EXISTS) {
            // An existing directory keeps its content; the descriptor is forced onto it.
            if (SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, user, nullptr, acl, nullptr) != ERROR_SUCCESS) failure = "cannot privatize existing directory";
          } else failure = "cannot create directory";
        }
      }
      LocalFree(acl);
    }
  }

  napi_value result, ok;
  napi_create_object(env, &result);
  napi_get_boolean(env, failure == nullptr, &ok);
  napi_set_named_property(env, result, "ok", ok);
  if (failure != nullptr) {
    napi_value named;
    napi_create_string_utf8(env, failure, NAPI_AUTO_LENGTH, &named);
    napi_set_named_property(env, result, "rejection", named);
  }
  return result;
}

}  // namespace

napi_value init(napi_env env, napi_value exports) {
  napi_value method, creator;
  napi_create_function(env, "verifyPrivate", NAPI_AUTO_LENGTH, verifyPrivate, nullptr, &method);
  napi_set_named_property(env, exports, "verifyPrivate", method);
  napi_create_function(env, "createPrivate", NAPI_AUTO_LENGTH, createPrivate, nullptr, &creator);
  napi_set_named_property(env, exports, "createPrivate", creator);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
