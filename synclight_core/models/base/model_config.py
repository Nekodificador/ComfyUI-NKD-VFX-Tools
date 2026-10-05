from pydantic.dataclasses import dataclass
from typing import Union, List

from ...config import BaseConfig
from pydantic import Field


@dataclass
class ModelConfig(BaseConfig):
    input_key: List[str] = Field(default_factory=list)
