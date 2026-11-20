from openenv.core.env_server.http_server import create_app
from .environment import ArenaAction, ArenaEnvironment, ArenaObservation

app = create_app(ArenaEnvironment, ArenaAction, ArenaObservation, env_name="metaharness_arena", max_concurrent_envs=8)
