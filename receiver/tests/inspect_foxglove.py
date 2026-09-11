import inspect
import foxglove
from foxglove import messages as schemas
from foxglove.websocket import Client, ServerListener

for value in (foxglove.start_server, foxglove.log, foxglove.Channel, schemas.RawImage, schemas.CompressedVideo, schemas.SceneUpdate, schemas.SceneEntity, schemas.LinePrimitive, schemas.CubePrimitive, schemas.Timestamp, Client, ServerListener):
    print(value.__name__, inspect.signature(value))
    if value in (Client, ServerListener):
        print([name for name in dir(value) if not name.startswith("_")])
print(foxglove.start_server.__doc__)
for name in ("LineType", "LinePrimitive", "SceneEntityDeletion", "SceneEntityDeletionType", "Duration", "Vector3", "Quaternion", "Pose", "Color"):
    value = getattr(schemas, name, None)
    print(name, value, getattr(value, "__members__", None))
    if value and not getattr(value, "__members__", None):
        print(inspect.signature(value))
print("Server methods", [name for name in dir(foxglove.websocket.WebSocketServer) if not name.startswith("_")])
