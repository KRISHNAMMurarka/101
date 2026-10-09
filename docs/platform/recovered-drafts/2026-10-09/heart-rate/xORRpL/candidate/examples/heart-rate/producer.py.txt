"""Execute only the exact pinned BlueZ fake notification callback, with no BlueZ imports."""
import sys
import os
if not (sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode and sys.flags.ignore_environment):
    raise RuntimeError('isolated startup required')
if not sys.pycache_prefix or not os.path.isdir(sys.pycache_prefix) or os.listdir(sys.pycache_prefix):
    raise RuntimeError('owned empty pycache prefix required')
import ast
import json
import hashlib
import types
import ctypes

SOURCE_SHA = 'a190508dd5bafd048ead4404535610c8c827181917cb569530f8de36ad329fd6'
METHOD_SHA = 'dd53fdcd2ea14b69dcdf106d501b960c933d5f738b7a46f7067df97d55426849'
AST_SHA = 'a8568f9ae00d3cad913fce6579b1a3104d31b0015526043294adfb7aaee4eac6'
PROFILE = 'app:hrs-1.0-heart-rate-notifications/1'
def digest(path):
    with open(path, 'rb') as file:
        return hashlib.sha256(file.read()).hexdigest()

def native_images():
    if sys.platform == 'darwin':
        host = ctypes.CDLL(None)
        count = host._dyld_image_count
        count.restype = ctypes.c_uint32
        name = host._dyld_get_image_name
        name.argtypes = [ctypes.c_uint32]
        name.restype = ctypes.c_char_p
        return sorted(set(os.fsdecode(name(i)) for i in range(count()) if name(i)))
    if sys.platform.startswith('linux'):
        with open('/proc/self/maps', encoding='utf-8') as maps:
            return sorted(set(line.rstrip().split()[-1] for line in maps if '/' in line and line.rstrip().split()[-1].startswith('/')))
    raise RuntimeError('native dependency readback unavailable')

def runtime_readback():
    modules = []
    intrinsic = []
    for name, module in sorted(sys.modules.items()):
        spec = getattr(module, '__spec__', None)
        origin = getattr(spec, 'origin', None)
        if origin in ('built-in', 'frozen'):
            intrinsic.append({'name': name, 'origin': origin})
        elif origin and os.path.isfile(origin):
            path = os.path.realpath(origin)
            modules.append({'name': name, 'path': path, 'sha256': digest(path)})
        elif name != '__main__' and origin is not None:
            raise RuntimeError('unrecorded module origin: ' + name)
    native = []
    boundary = []
    for image in native_images():
        path = os.path.realpath(image)
        if path.startswith(('/usr/lib/', '/System/Library/', '/Library/Apple/')):
            boundary.append({'path': path, 'reason': 'trusted-host-OS-or-system-cache'})
        elif os.path.isfile(path):
            native.append({'path': path, 'sha256': digest(path)})
        else:
            raise RuntimeError('unrecorded non-OS native dependency: ' + image)
    executable = os.path.realpath(sys.executable)
    return {'executable': executable, 'sha256': digest(executable), 'version': sys.version,
            'isolated': sys.flags.isolated, 'noSite': sys.flags.no_site,
            'dontWriteBytecode': sys.flags.dont_write_bytecode,
            'ignoreEnvironment': sys.flags.ignore_environment,
            'pycachePrefix': sys.pycache_prefix, 'sysPath': sys.path,
            'intrinsicModules': intrinsic, 'ordinaryModules': modules,
            'nonOSNativeDependencies': native, 'trustedOSBoundary': boundary}

if len(sys.argv) != 2:
    raise RuntimeError('explicit selected source required')
source_path = os.path.realpath(sys.argv[1])
if digest(source_path) != SOURCE_SHA:
    raise RuntimeError('selected source pin')
with open(source_path, 'r', encoding='utf-8') as file:
    source = file.read()
tree = ast.parse(source)
selected_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'HeartRateMeasurementChrc')
selected_method = next(node for node in selected_class.body if isinstance(node, ast.FunctionDef) and node.name == 'hr_msrmt_cb')
if hashlib.sha256(ast.get_source_segment(source, selected_method).encode()).hexdigest() != METHOD_SHA:
    raise RuntimeError('selected method pin')
if hashlib.sha256(ast.dump(selected_method, include_attributes=False).encode()).hexdigest() != AST_SHA:
    raise RuntimeError('selected AST pin')
if len(selected_method.args.args) != 1 or selected_method.args.args[0].arg != 'self' or selected_method.decorator_list:
    raise RuntimeError('selected method structure')
frames = []
random_index = 0
def selected_random(low, high):
    global random_index
    if (low, high) != (90, 130):
        raise RuntimeError('selected synthetic randint contract')
    value = 90 + random_index % 41
    random_index += 1
    return value

def changed(interface, value, invalidated):
    if interface != 'org.bluez.GattCharacteristic1' or list(value) != ['Value'] or invalidated != []:
        raise RuntimeError('selected output schema')
    frames.append(value['Value'])

selected_globals = {'dbus': types.SimpleNamespace(Byte=int), 'randint': selected_random,
                    'GATT_CHRC_IFACE': 'org.bluez.GattCharacteristic1', 'print': lambda *args: None}
exec(compile(ast.Module(body=[selected_method], type_ignores=[]), '<pinned-BlueZ-selected-method>', 'exec'), selected_globals)
callback = selected_globals['hr_msrmt_cb']
receiver = types.SimpleNamespace(service=types.SimpleNamespace(energy_expended=0),
                                hr_ee_count=0, notifying=True, PropertiesChanged=changed)
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()

emit({'type': 'hello', 'fixture': True, 'profileId': PROFILE, 'sourceSha256': SOURCE_SHA,
      'methodSha256': METHOD_SHA, 'astSha256': AST_SHA, 'feedback': 'absent',
      'vendorSensors': 'absent', 'runtime': runtime_readback()})
session = None
sequence = 0
for raw in sys.stdin.buffer:
    if len(raw) > 1024:
        raise RuntimeError('IPC line budget')
    message = json.loads(raw)
    kind = message.get('type')
    if kind == 'open' and set(message) == {'type', 'generation', 'token'} and session is None:
        if type(message['generation']) is not int or not 1 <= message['generation'] <= 16 or not isinstance(message['token'], str) or len(message['token']) != 32:
            raise RuntimeError('IPC identity')
        session = {'generation': message['generation'], 'token': message['token']}
        emit({'type': 'ready', **session})
    elif kind == 'tick' and set(message) == {'type', 'generation', 'token', 'sequence'} and session and all(message[key] == session[key] for key in session):
        if type(message['sequence']) is not int or message['sequence'] != sequence + 1 or sequence >= 11:
            raise RuntimeError('IPC sequence budget')
        sequence += 1
        callback(receiver)
        if len(frames) != 1:
            raise RuntimeError('selected callback output count')
        emit({'type': 'value', **session, 'sequence': sequence, 'fixture': True, 'bytes': frames.pop()})
    elif kind == 'stop' and set(message) == {'type', 'generation', 'token'} and session and all(message[key] == session[key] for key in session):
        previous = session
        session = None
        receiver.notifying = False
        emit({'type': 'stopped', **previous})
    elif kind == 'close' and set(message) == {'type'}:
        session = None
        receiver.notifying = False
        emit({'type': 'closed', 'runtime': runtime_readback()})
        break
    else:
        raise RuntimeError('IPC state/schema')
else:
    raise RuntimeError('EOF without explicit close')
