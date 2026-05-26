import pickle
from pathlib import Path

from .building_block import BuildingBlock
from .log import logger
from .topology import Topology


class Database:
    def __init__(self, topo_dir=None, bb_dir=None):
        db_path = Path(__file__).parent / "database"

        if topo_dir is None:
            self.topo_dir = db_path / "topologies"
            logger.debug("Default topology DB is loaded.")
        else:
            self.topo_dir = Path(topo_dir)
            logger.debug('topo_dir type is changed to %s' % type(self.topo_dir))

        if bb_dir is None:
            self.bb_dir = db_path / "bbs"
            logger.debug("Default building block DB is loaded.")
        else:
            self.bb_dir = Path(bb_dir)
            logger.debug('bb_dir type is changed to %s' % type(self.bb_dir))

        if not self.topo_dir.exists():
            message = "%s does not exist." % self.topo_dir
            logger.error(message)
            raise Exception(message)

        if not self.bb_dir.exists():
            message = "%s does not exist." % self.bb_dir
            logger.error(message)
            raise Exception(message)

    def _get_topology_list(self):
        return [p.stem for p in self.topo_dir.glob("*.cgd")]

    @property
    def topology_list(self):
        return self._get_topology_list()

    @property
    def topo_list(self):
        return self._get_topology_list()

    def _get_bb_list(self):
        return [p.stem for p in self.bb_dir.glob("*.xyz")]

    @property
    def building_block_list(self):
        return self._get_bb_list()

    @property
    def bb_list(self):
        return self._get_bb_list()

    def serialize(self):
        print("Database serialization starts.")
        n_topos = len(self.topo_list)
        for i, name in enumerate(self.topo_list, start=1):
            cgd_path = self.topo_dir / (name + ".cgd")
            try:
                topo = Topology(cgd_path)
            except Exception as e:
                logger.debug(f'Invalid topology {e}')
                continue

            # Save pickle
            pickle_path = self.topo_dir / (name + ".pickle")
            with pickle_path.open("wb") as f:
                pickle.dump(topo, f)
            logger.debug("Pickle %s saved" % pickle_path)

            percent = i / n_topos * 100
            print("\rProgress: %.1f %% (%d/%d)" % (percent, i, n_topos), end="")

    def get_topology(self, name):
        # Add .cgd to the topology name.
        pickle_path = self.topo_dir / (name + ".pickle")
        try:
            with pickle_path.open("rb") as f:
                topo = pickle.load(f)
            logger.debug("Topology is loaded from pickle.")
            return topo
        except Exception as e:
            # logger.exception(e)
            logger.debug("No %s.pickle in DB. Try cgd format.", name)

        cgd_path = self.topo_dir / (name + ".cgd")
        try:
            topo = Topology(cgd_path)
        except Exception as e:
            message = "Topology loading is failed: %s." % e
            logger.error(message)
            raise Exception(message)

        # Save pickle
        with pickle_path.open("wb") as f:
            pickle.dump(topo, f)
        logger.debug("Pickle %s saved" % pickle_path)

        return topo

    def get_topo(self, name):
        return self.get_topology(name)

    def get_building_block(self, name):
        # Add .xyz to the building block name.
        name = Path(name).stem + ".xyz"

        path = self.bb_dir / name

        try:
            bb = BuildingBlock(path)
        except Exception as e:
            message = "BuildingBlock loading is failed: %s." % e
            logger.error(message)
            raise Exception(message)

        return bb

    def get_bb(self, name):
        return self.get_building_block(name)
