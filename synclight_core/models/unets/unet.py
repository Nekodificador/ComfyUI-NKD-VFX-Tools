
from typing import Dict, List, Optional, Union

import torch
from diffusers.models import UNet2DConditionModel, UNet2DModel

from .unet_mvdream import UNet2DConditionModelMVDream


class DiffusersUNet2DWrapper(UNet2DModel):
    """
    Wrapper for the UNet2DModel from diffusers

    See diffusers' UNet2DModel for more details
    """

    def __init__(self, *args, **kwargs):
        UNet2DModel.__init__(self, *args, **kwargs)

    def forward(
        self,
        sample: torch.Tensor,
        timestep: Union[torch.Tensor, float, int],
        conditioning: Dict[str, torch.Tensor] = None,
        *args,
        **kwargs,
    ):
        """
        The forward pass of the model

        Args:

            sample (torch.Tensor): The input sample
            timesteps (Union[torch.Tensor, float, int]): The number of timesteps
        """
        if conditioning is not None:
            class_labels = conditioning["cond"].get("vector", None)
            concat = conditioning["cond"].get("concat", None)

        else:
            class_labels = None
            concat = None

        if concat is not None:
            if sample.shape[1] == 8 and concat.shape[1] == 2:
                # Concat four channels of sample, then one channel of concat and again the same
                sample = torch.cat([sample[:, :4, ...], concat[:, :1, ...], sample[:, 4:, ...], concat[:, 1:, ...]], dim=1)
            else:
                # Concat one
                sample = torch.cat([sample, concat], dim=1)

        return super().forward(sample, timestep, class_labels).sample

    def freeze(self):
        """
        Freeze the model
        """
        self.eval()
        for param in self.parameters():
            param.requires_grad = False


class DiffusersUNet2DCondWrapper(UNet2DConditionModel):
    """
    Wrapper for the UNet2DConditionModel from diffusers

    See diffusers' Unet2DConditionModel for more details
    """

    def __init__(self, *args, **kwargs):
        UNet2DConditionModel.__init__(self, *args, **kwargs)
        # BaseModel.__init__(self, config=ModelConfig())

    def forward(
        self,
        sample: torch.Tensor,
        timestep: Union[torch.Tensor, float, int],
        conditioning: Dict[str, torch.Tensor],
        ip_adapter_cond_embedding: Optional[List[torch.Tensor]] = None,
        down_block_additional_residuals: torch.Tensor = None,
        mid_block_additional_residual: torch.Tensor = None,
        down_intrablock_additional_residuals: torch.Tensor = None,
        *args,
        **kwargs,
    ):
        """
        The forward pass of the model

        Args:

            sample (torch.Tensor): The input sample
            timesteps (Union[torch.Tensor, float, int]): The number of timesteps
            conditioning (Dict[str, torch.Tensor]): The conditioning data
            down_block_additional_residuals (List[torch.Tensor]): Residuals for the down blocks.
                These residuals typically are used for the controlnet.
            mid_block_additional_residual (List[torch.Tensor]): Residuals for the mid blocks.
                These residuals typically are used for the controlnet.
            down_intrablock_additional_residuals (List[torch.Tensor]): Residuals for the down intrablocks.
                These residuals typically are used for the T2I adapters.middle block outputs. Defaults to False
        """

        assert isinstance(conditioning, dict), "conditionings must be a dictionary"
        # assert "crossattn" in conditioning["cond"], "crossattn must be in conditionings"

        class_labels = conditioning["cond"].get("vector", None)
        crossattn = conditioning["cond"].get("crossattn", None)
        concat = conditioning["cond"].get("concat", None)

        # concat conditioning
        if concat is not None:
            sample = torch.cat([sample, concat], dim=1)

        # down_intrablock_additional_residuals needs to be cloned, since unet will modify it
        if down_intrablock_additional_residuals is not None:
            down_intrablock_additional_residuals_clone = [
                curr_residuals.clone()
                for curr_residuals in down_intrablock_additional_residuals
            ]
        else:
            down_intrablock_additional_residuals_clone = None

        # Check diffusers.models.embeddings.py > MultiIPAdapterImageProjectionLayer > forward() for implementation
        # Exepected format : List[torch.Tensor] of shape (batch_size, num_image_embeds, embed_dim)
        # with length = number of ip_adapters loaded in the ip_adapter_wrapper
        if ip_adapter_cond_embedding is not None:
            added_cond_kwargs = {
                "image_embeds": [
                    ip_adapter_embedding.unsqueeze(1)
                    for ip_adapter_embedding in ip_adapter_cond_embedding
                ]
            }
        else:
            added_cond_kwargs = None

        return (
            super()
            .forward(
                sample=sample,
                timestep=timestep,
                encoder_hidden_states=crossattn,
                class_labels=class_labels,
                added_cond_kwargs=added_cond_kwargs,
                down_block_additional_residuals=down_block_additional_residuals,
                mid_block_additional_residual=mid_block_additional_residual,
                down_intrablock_additional_residuals=down_intrablock_additional_residuals_clone,
            )
            .sample
        )

    def freeze(self):
        """
        Freeze the model
        """
        self.eval()
        for param in self.parameters():
            param.requires_grad = False


class DiffusersUNet2DCondMVDreamWrapper(UNet2DConditionModelMVDream):
    """
    Wrapper for the UNet2DConditionModelMVDream (MVDream-style with 3D attention)

    This wrapper extends the MVDream UNet to work with LBM's conditioning system,
    providing:
    - 3D attention across multiple views
    - Camera parameter embeddings
    - Compatibility with LBM's conditioning format
    - Weight loading from Stability AI models
    """

    def __init__(self, *args, **kwargs):
        UNet2DConditionModelMVDream.__init__(self, *args, **kwargs)

    def forward(
        self,
        sample: torch.Tensor,
        timestep: Union[torch.Tensor, float, int],
        conditioning: Dict[str, torch.Tensor],
        ip_adapter_cond_embedding: Optional[List[torch.Tensor]] = None,
        down_block_additional_residuals: torch.Tensor = None,
        mid_block_additional_residual: torch.Tensor = None,
        down_intrablock_additional_residuals: torch.Tensor = None,
        camera: Optional[torch.Tensor] = None,
        num_frames: Optional[int] = None,
        *args,
        **kwargs,
    ):
        """
        The forward pass of the model with LBM-style conditioning.

        Args:
            sample (torch.Tensor): The input sample of shape (batch_size * num_frames, channels, height, width)
            timestep (Union[torch.Tensor, float, int]): The number of timesteps
            conditioning (Dict[str, torch.Tensor]): The conditioning data with keys:
                - 'cond': Dictionary containing:
                    - 'vector': Class/vector embeddings (optional)
                    - 'crossattn': Cross-attention embeddings (optional)
                    - 'concat': Concatenated conditioning images (optional)
                - 'camera': Camera parameters (optional, can also be passed directly)
            ip_adapter_cond_embedding (List[torch.Tensor]): IP-Adapter embeddings
            down_block_additional_residuals: Residuals for the down blocks (e.g., ControlNet)
            mid_block_additional_residual: Residuals for the mid blocks (e.g., ControlNet)
            down_intrablock_additional_residuals: Residuals for the down intrablocks (e.g., T2I-Adapter)
            camera (torch.Tensor): Camera parameters of shape (batch_size, camera_dim) or (batch_size * num_frames, camera_dim)
            num_frames (int): Number of views/frames (overrides model's default if provided)

        Returns:
            torch.Tensor: The model output
        """

        assert isinstance(conditioning, dict), "conditionings must be a dictionary"

        class_labels = conditioning["cond"].get("vector", None)
        crossattn = conditioning["cond"].get("crossattn", None)
        concat = conditioning["cond"].get("concat", None)

        # Extract camera from conditioning if not provided directly
        if camera is None and "camera" in conditioning["cond"]:
            camera = conditioning["cond"]["camera"]

        # Concat conditioning to sample
        if concat is not None:
            sample = torch.cat([sample, concat], dim=1)

        # Clone down_intrablock_additional_residuals since unet will modify it
        if down_intrablock_additional_residuals is not None:
            down_intrablock_additional_residuals_clone = [
                curr_residuals.clone()
                for curr_residuals in down_intrablock_additional_residuals
            ]
        else:
            down_intrablock_additional_residuals_clone = None

        # Prepare IP-Adapter embeddings
        if ip_adapter_cond_embedding is not None:
            added_cond_kwargs = {
                "image_embeds": [
                    ip_adapter_embedding.unsqueeze(1)
                    for ip_adapter_embedding in ip_adapter_cond_embedding
                ]
            }
        else:
            added_cond_kwargs = None

        # Call parent's forward with MVDream-specific parameters
        return (
            super()
            .forward(
                sample=sample,
                timestep=timestep,
                encoder_hidden_states=crossattn,
                class_labels=class_labels,
                added_cond_kwargs=added_cond_kwargs,
                down_block_additional_residuals=down_block_additional_residuals,
                mid_block_additional_residual=mid_block_additional_residual,
                down_intrablock_additional_residuals=down_intrablock_additional_residuals_clone,
                camera=camera,
                num_frames=num_frames,
            )
            .sample
        )

    def freeze(self):
        """
        Freeze the model
        """
        self.eval()
        for param in self.parameters():
            param.requires_grad = False
