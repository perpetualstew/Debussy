"""BlueZ GATT bridge; Linux only. Bond and trust the iPhone during setup."""
import argparse
import json
from pathlib import Path
import threading
import time
from .model import canonical
from .presenter import rpc, MAX_MESSAGE

SERVICE = "d8aa0001-6921-4f5e-9c21-7069616e6f31"
RX = "d8aa0002-6921-4f5e-9c21-7069616e6f31"
TX = "d8aa0003-6921-4f5e-9c21-7069616e6f31"


def main():
    import dbus
    import dbus.service
    from dbus.mainloop.glib import DBusGMainLoop
    from gi.repository import GLib

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", default="hci0")
    parser.add_argument("--socket", type=Path, default=Path.home()/".cache/piano-perform/control.sock")
    args = parser.parse_args()
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    props_iface = "org.freedesktop.DBus.Properties"
    service_iface = "org.bluez.GattService1"
    char_iface = "org.bluez.GattCharacteristic1"
    base = "/com/pianolibrary/perform"

    class Denied(dbus.exceptions.DBusException):
        _dbus_error_name = "org.bluez.Error.NotAuthorized"

    class Invalid(dbus.exceptions.DBusException):
        _dbus_error_name = "org.bluez.Error.InvalidValueLength"

    class Bridge:
        def __init__(self):
            self.owner, self.buffer, self.reply = None, bytearray(), bytearray()
            self.generation, self.last = 0, 0

        def authorize(self, options):
            device = options.get("device")
            if not device:
                raise Denied("Missing bonded device")
            props = dbus.Interface(bus.get_object("org.bluez", device), props_iface)
            if not props.Get("org.bluez.Device1", "Paired") or not props.Get("org.bluez.Device1", "Trusted"):
                raise Denied("Pair and trust this iPhone on the Pi first")
            return str(device)

        def write(self, value, options):
            device = self.authorize(options)
            data = bytes(value)
            if data.startswith(b"\x1e"):
                if self.owner not in (None, device) and time.monotonic()-self.last < 120:
                    raise Denied("Another controller owns this session")
                self.owner, self.buffer, self.reply = device, bytearray(), bytearray()
                self.generation += 1
                data = data[1:]
            if self.owner != device:
                raise Denied("Start a framed request")
            self.last = time.monotonic()
            self.buffer.extend(data)
            if len(self.buffer) > MAX_MESSAGE:
                self.buffer.clear()
                raise Invalid("Request too large")
            if self.buffer.endswith(b"\n"):
                raw = bytes(self.buffer)
                self.buffer.clear()
                generation = self.generation

                def worker():
                    request_id = None
                    try:
                        request = json.loads(raw)
                        request_id = request.pop("requestID")
                        result = rpc(args.socket, request)
                    except Exception as error:
                        result = dict(ok=False, error=str(error))
                    result["requestID"] = request_id

                    def complete():
                        if self.generation == generation:
                            self.reply = bytearray(canonical(result) + b"\n")
                        return False
                    GLib.idle_add(complete)
                threading.Thread(target=worker, daemon=True).start()

        def read(self, options):
            device = self.authorize(options)
            if self.owner != device:
                return b""
            # Small acknowledged reads avoid unacknowledged notification loss
            # and work with the minimum ATT MTU. iPhone polls until newline.
            chunk = bytes(self.reply[:20])
            del self.reply[:20]
            return chunk

    bridge = Bridge()

    class Object(dbus.service.Object):
        def __init__(self, path, iface, properties):
            self.path, self.iface, self.properties = path, iface, properties
            super().__init__(bus, path)

        @dbus.service.method(props_iface, in_signature="s", out_signature="a{sv}")
        def GetAll(self, interface):
            return self.properties if interface == self.iface else {}

        @dbus.service.method(props_iface, in_signature="ss", out_signature="v")
        def Get(self, interface, name):
            return self.GetAll(interface)[name]

    class Characteristic(Object):
        @dbus.service.method(char_iface, in_signature="aya{sv}", out_signature="")
        def WriteValue(self, value, options):
            if self.properties["UUID"] != RX:
                raise Denied("Read-only characteristic")
            bridge.write(value, options)

        @dbus.service.method(char_iface, in_signature="a{sv}", out_signature="ay")
        def ReadValue(self, options):
            if self.properties["UUID"] != TX:
                raise Denied("Write-only characteristic")
            return dbus.Array(bridge.read(options), signature="y")

    service = Object(base+"/service0", service_iface, dict(UUID=SERVICE, Primary=dbus.Boolean(True), Includes=dbus.Array([], signature="o")))
    rx = Characteristic(service.path+"/rx", char_iface, dict(UUID=RX, Service=dbus.ObjectPath(service.path), Flags=dbus.Array(["write", "encrypt-write"], signature="s")))
    tx = Characteristic(service.path+"/tx", char_iface, dict(UUID=TX, Service=dbus.ObjectPath(service.path), Flags=dbus.Array(["read", "encrypt-read"], signature="s")))

    class Application(dbus.service.Object):
        @dbus.service.method("org.freedesktop.DBus.ObjectManager", out_signature="a{oa{sa{sv}}}")
        def GetManagedObjects(self):
            return {obj.path: {obj.iface: obj.properties} for obj in (service, rx, tx)}

    class Advertisement(Object):
        @dbus.service.method("org.bluez.LEAdvertisement1", in_signature="", out_signature="")
        def Release(self):
            pass

    app = Application(bus, base)
    ad = Advertisement(base+"/advertisement", "org.bluez.LEAdvertisement1", dict(Type="peripheral", ServiceUUIDs=dbus.Array([SERVICE], signature="s"), LocalName="Piano Library"))
    adapter = bus.get_object("org.bluez", f"/org/bluez/{args.adapter}")
    manager = dbus.Interface(adapter, "org.bluez.GattManager1")
    advertising = dbus.Interface(adapter, "org.bluez.LEAdvertisingManager1")
    loop = GLib.MainLoop()
    errors = []
    def registration_error(error):
        errors.append(str(error))
        print(f"Bluetooth registration failed: {error}", flush=True)
        loop.quit()
    # BlueZ calls back into our object manager during registration.
    manager.RegisterApplication(base, {}, reply_handler=lambda: print("GATT ready", flush=True), error_handler=registration_error)
    advertising.RegisterAdvertisement(ad.path, {}, reply_handler=lambda: print("Advertising Piano Library", flush=True), error_handler=registration_error)
    try:
        loop.run()
    finally:
        for unregister, path in [(advertising.UnregisterAdvertisement, ad.path), (manager.UnregisterApplication, base)]:
            try:
                unregister(path)
            except dbus.exceptions.DBusException:
                pass
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
