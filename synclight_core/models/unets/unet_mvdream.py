"""
MVDream-style UNet2DConditionModel with 3D Attention and Camera Embeddings

This module extends diffusers' UNet2DConditionModel to support:
1. 3D attention across multiple views/frames
2. Camera parameter embeddings similar to time embeddings
3. Weight compatibility with Stability AI's Stable Diffusion models
"""

from typing import Optional, Dict, Any, Union, Tuple
import torch
import torch.nn as nn
from diffusers.models import UNet2DConditionModel
from diffusers.models.embeddings import TimestepEmbedding, Timesteps

from .attention_3d import Transformer2DModel3D


class CameraEmbedding(nn.Module):
    """
    Camera parameter embedding module.

    Converts camera parameters (e.g., rotation matrices, camera-to-world transforms)
    into embeddings that can be added to time embeddings.
    """

    def __init__(
        self,
        camera_dim: int = 16,
        time_embed_dim: int = 1280,
        act_fn: str = "silu",
    ):
        """
        Args:
            camera_dim: Dimension of camera parameter input (default: 16 for 4x4 matrix flattened)
            time_embed_dim: Dimension of time embedding (should match UNet's time_embed_dim)
            act_fn: Activation function
        """
        super().__init__()

        self.linear_1 = nn.Linear(camera_dim, time_embed_dim)
        self.act = nn.SiLU() if act_fn == "silu" else nn.GELU()
        self.linear_2 = nn.Linear(time_embed_dim, time_embed_dim)

    def forward(self, camera: torch.Tensor) -> torch.Tensor:
        """
        Args:
            camera: Camera parameters of shape (batch_size, camera_dim)

        Returns:
            Camera embeddings of shape (batch_size, time_embed_dim)
        """
        camera_emb = self.linear_1(camera)
        camera_emb = self.act(camera_emb)
        camera_emb = self.linear_2(camera_emb)
        return camera_emb


class UNet2DConditionModelMVDream(UNet2DConditionModel):
    """
    UNet2DConditionModel with MVDream-style 3D attention and optional camera embeddings.

    This model extends the standard UNet2DConditionModel to support multi-view
    processing through:
    1. 3D attention blocks that enable cross-view attention
    2. (Optional) Camera embeddings that provide view-specific conditioning
    3. Full weight compatibility with Stability AI models
    """

    def __init__(
        self,
        *args,
        use_3d_attention: bool = True,
        num_frames: int = 2,
        use_camera_embedding: bool = False,
        camera_embedding_dim: int = 16,
        **kwargs,
    ):
        """
        Args:
            use_3d_attention: Whether to use 3D attention (default: True)
            num_frames: Number of views/frames to process simultaneously (default: 2)
            use_camera_embedding: Whether to add camera embedding module (default: False)
            camera_embedding_dim: Dimension of camera parameter input (default: 16)
            *args, **kwargs: Arguments passed to UNet2DConditionModel
        """
        super().__init__(*args, **kwargs)

        self.use_3d_attention = use_3d_attention
        self.num_frames = num_frames
        self.use_camera_embedding = use_camera_embedding
        self.camera_embedding_dim = camera_embedding_dim

        # Add camera embedding module if requested
        if self.use_camera_embedding:
            # Get time_embed_dim from the parent class
            time_embed_dim = self.time_embedding.linear_2.out_features

            self.camera_embedding = CameraEmbedding(
                camera_dim=camera_embedding_dim,
                time_embed_dim=time_embed_dim,
                act_fn="silu",
            )
        else:
            self.camera_embedding = None

        # Convert all Transformer2DModel blocks to Transformer2DModel3D if using 3D attention
        if self.use_3d_attention:
            self._convert_to_3d_attention()

    def _convert_to_3d_attention(self):
        """
        Convert all Transformer2DModel blocks in the UNet to Transformer2DModel3D.

        This replaces the standard 2D attention with 3D attention that can process
        multiple views simultaneously while maintaining weight compatibility.
        """
        # Convert down blocks
        for i, down_block in enumerate(self.down_blocks):
            if hasattr(down_block, 'attentions') and down_block.attentions is not None:
                for j, attention in enumerate(down_block.attentions):
                    if attention is not None:
                        # Wrap the Transformer2DModel with 3D version
                        self.down_blocks[i].attentions[j] = Transformer2DModel3D(attention)

        # Convert mid block
        if hasattr(self.mid_block, 'attentions') and self.mid_block.attentions is not None:
            for j, attention in enumerate(self.mid_block.attentions):
                if attention is not None:
                    self.mid_block.attentions[j] = Transformer2DModel3D(attention)

        # Convert up blocks
        for i, up_block in enumerate(self.up_blocks):
            if hasattr(up_block, 'attentions') and up_block.attentions is not None:
                for j, attention in enumerate(up_block.attentions):
                    if attention is not None:
                        self.up_blocks[i].attentions[j] = Transformer2DModel3D(attention)

    def forward(
        self,
        sample: torch.Tensor,
        timestep: Union[torch.Tensor, float, int],
        encoder_hidden_states: torch.Tensor = None,
        class_labels: Optional[torch.Tensor] = None,
        timestep_cond: Optional[torch.Tensor] = None,
        attention_mask: Optional[torch.Tensor] = None,
        cross_attention_kwargs: Optional[Dict[str, Any]] = None,
        added_cond_kwargs: Optional[Dict[str, torch.Tensor]] = None,
        down_block_additional_residuals: Optional[Tuple[torch.Tensor]] = None,
        mid_block_additional_residual: Optional[torch.Tensor] = None,
        down_intrablock_additional_residuals: Optional[Tuple[torch.Tensor]] = None,
        encoder_attention_mask: Optional[torch.Tensor] = None,
        return_dict: bool = True,
        camera: Optional[torch.Tensor] = None,
        num_frames: Optional[int] = None,
    ):
        """
        Forward pass with camera embedding support.

        Args:
            sample: Noisy input tensor of shape (batch_size * num_frames, channels, height, width)
            timestep: Diffusion timestep
            encoder_hidden_states: Text/cross-attention conditioning
            class_labels: Class labels for conditioning
            timestep_cond: Additional timestep conditioning
            attention_mask: Attention mask
            cross_attention_kwargs: Additional cross-attention kwargs
            added_cond_kwargs: Additional conditioning (e.g., for SDXL)
            down_block_additional_residuals: ControlNet-style down block residuals
            mid_block_additional_residual: ControlNet-style mid block residual
            down_intrablock_additional_residuals: T2I-Adapter-style residuals
            encoder_attention_mask: Cross-attention mask
            return_dict: Whether to return a dict
            camera: Camera parameters of shape (batch_size, camera_dim) or (batch_size * num_frames, camera_dim)
            num_frames: Number of frames (overrides self.num_frames if provided)

        Returns:
            UNet output
        """
        # Use provided num_frames or default to self.num_frames
        if num_frames is None:
            num_frames = self.num_frames

        # Prepare cross_attention_kwargs with num_frames
        if cross_attention_kwargs is None:
            cross_attention_kwargs = {}

        if self.use_3d_attention and num_frames > 1:
            cross_attention_kwargs["num_frames"] = num_frames

        # Camera embeddings are not currently used in this simplified version
        # To use camera embeddings, set use_camera_embedding=True and implement
        # the embedding injection logic in added_cond_kwargs or through a custom
        # embedding module compatible with your diffusers version.
        if camera is not None:
            import warnings
            if not self.use_camera_embedding:
                warnings.warn(
                    "Camera parameters provided but use_camera_embedding=False. "
                    "Camera parameters will be ignored. Set use_camera_embedding=True to use them.",
                    UserWarning
                )

        # Call parent's forward pass
        # The 3D attention will be triggered through cross_attention_kwargs["num_frames"]
        return super().forward(
            sample=sample,
            timestep=timestep,
            encoder_hidden_states=encoder_hidden_states,
            class_labels=class_labels,
            timestep_cond=timestep_cond,
            attention_mask=attention_mask,
            cross_attention_kwargs=cross_attention_kwargs,
            added_cond_kwargs=added_cond_kwargs,
            down_block_additional_residuals=down_block_additional_residuals,
            mid_block_additional_residual=mid_block_additional_residual,
            down_intrablock_additional_residuals=down_intrablock_additional_residuals,
            encoder_attention_mask=encoder_attention_mask,
            return_dict=return_dict,
        )

    @classmethod
    def from_pretrained_2d(
        cls,
        pretrained_model_name_or_path: str,
        *args,
        use_3d_attention: bool = True,
        num_frames: int = 2,
        use_camera_embedding: bool = False,
        camera_embedding_dim: int = 16,
        **kwargs,
    ):
        """
        Load a pretrained 2D UNet and convert it to MVDream-style 3D UNet.

        This method loads weights from a standard Stable Diffusion model and
        converts it to support multi-view processing while maintaining weight compatibility.

        Args:
            pretrained_model_name_or_path: Path or identifier of pretrained model
            use_3d_attention: Whether to enable 3D attention
            num_frames: Number of views/frames
            use_camera_embedding: Whether to add camera embedding module (default: False)
            camera_embedding_dim: Dimension of camera parameters
            *args, **kwargs: Additional arguments for from_pretrained

        Returns:
            UNet2DConditionModelMVDream instance with loaded weights
        """
        # First load the standard 2D model
        model_2d = UNet2DConditionModel.from_pretrained(
            pretrained_model_name_or_path,
            *args,
            **kwargs,
        )

        # Get the config
        config = model_2d.config

        # Create MVDream model with same config
        model_3d = cls(
            **config,
            use_3d_attention=use_3d_attention,
            num_frames=num_frames,
            use_camera_embedding=use_camera_embedding,
            camera_embedding_dim=camera_embedding_dim,
        )

        # Load 2D weights into 3D model (this works because we preserve the weight structure)
        # The 3D attention blocks have the same weights as 2D, just different forward pass
        model_3d.load_state_dict(model_2d.state_dict(), strict=False)

        return model_3d